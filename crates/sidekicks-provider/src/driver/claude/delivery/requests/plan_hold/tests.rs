use std::error::Error;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::plan::{PlanHoldEndedReason, PlanId};
use sidekicks_std::mutex_lock::lock;
use tokio::sync::Semaphore;

use super::{PLAN_KEPT_REASON, PLAN_UNSHOWN_REASON};
use crate::driver::claude::session::scripted::channel::ScriptedWrite;
use crate::driver::claude::session::scripted::{ScriptedSession, settle};
use crate::driver::diagnostics::RecordedEvents;
use crate::port::plan::{PlanPort, ProviderPlan, ProviderPlanHoldEnd};

// A plan record that keeps each plan taken, each hold ended and the plans waiting, whose takes
// wait while held, each on a gate of its own, and fail once told to. A take that passes its gate
// commits: it sets aside every plan still waiting, as the record's write does.
#[derive(Default)]
struct PlanRecord {
    taken: Mutex<Vec<ProviderPlan>>,
    hold_ends: Mutex<Vec<ProviderPlanHoldEnd>>,
    waiting: Arc<Mutex<Vec<PlanId>>>,
    is_holding: Mutex<bool>,
    take_gates: Mutex<Vec<Arc<Semaphore>>>,
    is_failing: Mutex<bool>,
}

impl PlanRecord {
    // A record registered on `session`'s requests, whose takes wait until released when `is_held`.
    fn registered(session: &ScriptedSession, is_held: bool) -> Arc<Self> {
        let record = Arc::new(Self::default());
        if is_held {
            record.hold_takes();
        }
        let port: Arc<dyn PlanPort> = record.clone();
        assert!(session.requests.dependencies.plans.register(port).is_ok());
        record
    }

    // Holds every take started from now until released.
    fn hold_takes(&self) {
        *lock(&self.is_holding) = true;
    }

    fn fail_takes(&self) {
        *lock(&self.is_failing) = true;
    }

    // Lets every held take through, and every later one.
    fn release_takes(&self) {
        *lock(&self.is_holding) = false;
        for gate in lock(&self.take_gates).iter() {
            gate.close();
        }
    }

    // Lets the take started `index`th through, the first being 0.
    fn release_take(&self, index: usize) {
        lock(&self.take_gates)[index].close();
    }

    fn taken(&self) -> Vec<ProviderPlan> {
        lock(&self.taken).clone()
    }

    fn hold_ends(&self) -> Vec<ProviderPlanHoldEnd> {
        lock(&self.hold_ends).clone()
    }

    fn waiting(&self) -> Vec<PlanId> {
        lock(&self.waiting).clone()
    }
}

impl PlanPort for PlanRecord {
    fn take_plan(
        &self,
        plan: ProviderPlan,
    ) -> BoxFuture<'_, Result<Vec<PlanId>, Box<dyn Error + Send + Sync>>> {
        let plan_id = plan.plan_id;
        lock(&self.taken).push(plan);
        let gate = lock(&self.is_holding).then(|| {
            let gate = Arc::new(Semaphore::new(0));
            lock(&self.take_gates).push(Arc::clone(&gate));
            gate
        });
        let is_failing = *lock(&self.is_failing);
        let waiting = Arc::clone(&self.waiting);
        async move {
            if let Some(gate) = gate {
                // The gate only ever closes, which lets the take through.
                let _closed = gate.acquire().await;
            }
            if is_failing {
                return Err("the plan record could not be written".into());
            }
            Ok(std::mem::replace(&mut *lock(&waiting), vec![plan_id]))
        }
        .boxed()
    }

    fn end_plan_hold(
        &self,
        hold_end: ProviderPlanHoldEnd,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        lock(&self.hold_ends).push(hold_end);
        async { Ok(()) }.boxed()
    }
}

fn plan_exit() -> Value {
    json!({
        "subtype": "can_use_tool",
        "tool_name": "ExitPlanMode",
        "tool_use_id": "call-1",
        "input": {"plan": "1. Read the code.\n2. Change it."},
    })
}

fn withdrawn(session: &ScriptedSession, plan_id: PlanId) -> ProviderPlanHoldEnd {
    ProviderPlanHoldEnd {
        session_id: session.session_id,
        plan_id,
        reason: PlanHoldEndedReason::Withdrawn,
    }
}

fn has_answer(session: &ScriptedSession) -> bool {
    !answers(session).is_empty()
}

// Each answer written to a request, by its request id.
fn answers(session: &ScriptedSession) -> Vec<(String, Value)> {
    session
        .channel
        .writes()
        .into_iter()
        .filter_map(|write| match write {
            ScriptedWrite::Answer { request_id, answer } => Some((request_id, answer)),
            ScriptedWrite::Control(_) | ScriptedWrite::User(_) | ScriptedWrite::Terminate => None,
        })
        .collect()
}

fn denial(request_id: &str, message: &str) -> (String, Value) {
    (
        request_id.to_owned(),
        json!({"behavior": "deny", "message": message}),
    )
}

// Why a plan could not reach the record.
#[derive(Clone, Copy, Debug)]
enum Unrecorded {
    NoText,
    BlankText,
    NoRecord,
    TakeFailed,
}

// A plan request reaches only the plan record, under the id the driver minted, and a verdict finds
// it by that id while the record is still being written. Killed by leaving the fall-through to
// the approval pipeline in.
#[tokio::test(start_paused = true)]
async fn a_plan_is_held_under_its_minted_id_and_never_asked() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    let record = PlanRecord::registered(&session, true);

    session.request("plan", &plan_exit());
    settle().await;

    let taken = record.taken();
    assert_eq!(taken.len(), 1);
    assert_eq!(taken[0].text, "1. Read the code.\n2. Change it.");
    assert!(taken[0].holds_request);
    let plan_id = taken[0].plan_id;
    assert_eq!(
        session
            .requests
            .held_plan_request(session.session_id, plan_id)
            .as_deref(),
        Some("plan"),
        "found from admission, while the take runs"
    );
    assert_eq!(session.ports.calls(), [], "no permission ask");
    record.release_takes();
    settle().await;
    assert_eq!(session.ports.calls(), []);
    assert!(!has_answer(&session));
}

// A withdrawal while the take runs is reported once the take returns, and only once; one after the
// take is reported at once. Killed by the take's withdrawal mark missing, and by a second report
// from the withdrawal itself.
#[tokio::test(start_paused = true)]
async fn a_withdrawn_plan_is_reported_once_whenever_it_was_withdrawn() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    let record = PlanRecord::registered(&session, true);

    session.request("during", &plan_exit());
    settle().await;
    session.cancel("during");
    settle().await;
    assert_eq!(record.hold_ends(), [], "nothing before the take returns");
    let during = record.taken()[0].plan_id;
    record.release_takes();
    settle().await;
    assert_eq!(record.hold_ends(), [withdrawn(&session, during)]);

    session.request("after", &plan_exit());
    settle().await;
    let after = record.taken()[1].plan_id;
    session.cancel("after");
    settle().await;
    assert_eq!(
        record.hold_ends(),
        [withdrawn(&session, during), withdrawn(&session, after)]
    );
    assert_eq!(session.requests.open_request_count(session.session_id), 0);
}

// A held plan is an open request: the idle sleep counts it, a steer waits behind it, and no time
// that passes answers or ends it. Killed by keeping the plan outside the request table, and by a
// timer on the hold.
#[tokio::test(start_paused = true)]
async fn a_held_plan_holds_the_session_open_for_any_time() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    let record = PlanRecord::registered(&session, false);

    session.request("plan", &plan_exit());
    settle().await;
    tokio::time::advance(Duration::from_hours(400 * 24)).await;
    settle().await;

    let plan_id = record.taken()[0].plan_id;
    assert_eq!(session.requests.open_request_count(session.session_id), 1);
    assert!(
        session
            .requests
            .wait_asks_closed(session.session_id)
            .is_some(),
        "a steer waits behind the plan"
    );
    assert!(
        session
            .requests
            .held_plan_request(session.session_id, plan_id)
            .is_some()
    );
    assert_eq!(record.hold_ends(), []);
    assert!(!has_answer(&session));
}

// A gone process's held plans are dropped with no report, whether their take had returned or was
// still running, since the run's end settles them. Killed by sending a plan through the
// withdrawal arm, and by the take reading any letting go as a withdrawal.
#[tokio::test(start_paused = true)]
async fn a_gone_process_drops_its_held_plans_unreported() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    let record = PlanRecord::registered(&session, true);
    session.request("taking", &plan_exit());
    settle().await;

    session.requests.forget_session(session.session_id);
    record.release_takes();
    settle().await;
    session.request("taken", &plan_exit());
    settle().await;
    session.requests.forget_session(session.session_id);
    settle().await;

    assert_eq!(record.taken().len(), 2);
    assert_eq!(record.hold_ends(), []);
    assert_eq!(session.requests.open_request_count(session.session_id), 0);
}

// A plan request whose plan cannot be recorded, for want of text, of a registered record or of a
// take that succeeds, is refused at once with the plan sentence and recorded as not recorded, and
// one with no text records nothing. Killed by leaving the request held.
#[rstest]
#[case::no_text(Unrecorded::NoText)]
#[case::blank_text(Unrecorded::BlankText)]
#[case::no_record(Unrecorded::NoRecord)]
#[case::take_failed(Unrecorded::TakeFailed)]
#[tokio::test(start_paused = true)]
async fn a_plan_that_cannot_be_recorded_is_refused_at_once(#[case] unrecorded: Unrecorded) {
    let recorded = RecordedEvents::default();
    let _recording = recorded.record_until_dropped();
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    let record = match unrecorded {
        Unrecorded::NoRecord => None,
        Unrecorded::NoText | Unrecorded::BlankText | Unrecorded::TakeFailed => {
            Some(PlanRecord::registered(&session, false))
        }
    };
    if let (Unrecorded::TakeFailed, Some(record)) = (unrecorded, &record) {
        record.fail_takes();
    }
    let mut request = plan_exit();
    match unrecorded {
        Unrecorded::NoText => request["input"] = json!({}),
        Unrecorded::BlankText => request["input"] = json!({"plan": " \n "}),
        Unrecorded::NoRecord | Unrecorded::TakeFailed => {}
    }

    session.request("plan", &request);
    settle().await;

    assert_eq!(answers(&session), [denial("plan", PLAN_UNSHOWN_REASON)]);
    assert_eq!(session.requests.open_request_count(session.session_id), 0);
    assert!(
        recorded
            .counters()
            .contains(&"driver.plan.notRecorded".to_owned()),
        "{:?}",
        recorded.counters()
    );
    if let (Unrecorded::NoText | Unrecorded::BlankText, Some(record)) = (unrecorded, &record) {
        assert_eq!(record.taken(), [], "no plan is recorded");
    }
}

// A second plan while one is held answers the older to wait once the newer is recorded, and not
// before. Killed by leaving the older held, and by answering it before the newer's take returns.
#[tokio::test(start_paused = true)]
async fn a_newer_plan_recorded_lets_the_older_go() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    let record = PlanRecord::registered(&session, false);
    session.request("older", &plan_exit());
    settle().await;
    let older = record.taken()[0].plan_id;

    record.hold_takes();
    session.request("newer", &plan_exit());
    settle().await;
    assert!(
        !has_answer(&session),
        "nothing before the newer is recorded"
    );
    assert!(
        session
            .requests
            .held_plan_request(session.session_id, older)
            .is_some()
    );
    assert_eq!(session.requests.open_request_count(session.session_id), 2);

    record.release_takes();
    settle().await;
    let newer = record.taken()[1].plan_id;
    assert_eq!(answers(&session), [denial("older", PLAN_KEPT_REASON)]);
    assert_eq!(session.requests.open_request_count(session.session_id), 1);
    assert_eq!(
        session
            .requests
            .held_plan_request(session.session_id, newer)
            .as_deref(),
        Some("newer")
    );
    assert_eq!(record.hold_ends(), []);
}

// Two plans whose records commit in the reverse of their asking: the plan committed last waits with
// its request held, and the one its record set aside is answered to wait. Killed by choosing the
// plans to answer by the order they were asked.
#[tokio::test(start_paused = true)]
async fn the_plan_recorded_last_stands_whatever_order_they_were_asked() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    let record = PlanRecord::registered(&session, true);
    session.request("first", &plan_exit());
    session.request("second", &plan_exit());
    settle().await;
    let (first, second) = (record.taken()[0].plan_id, record.taken()[1].plan_id);

    record.release_take(1);
    settle().await;
    assert!(!has_answer(&session), "the second set nothing aside");
    record.release_take(0);
    settle().await;

    assert_eq!(record.waiting(), [first]);
    assert_eq!(answers(&session), [denial("second", PLAN_KEPT_REASON)]);
    assert_eq!(
        session
            .requests
            .held_plan_request(session.session_id, first)
            .as_deref(),
        Some("first")
    );
    assert!(
        session
            .requests
            .held_plan_request(session.session_id, second)
            .is_none()
    );
    assert_eq!(session.requests.open_request_count(session.session_id), 1);
}
