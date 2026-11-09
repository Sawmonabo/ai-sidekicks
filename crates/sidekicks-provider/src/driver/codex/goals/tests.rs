use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_ipc::domain_error::DomainError;

use super::{CodexSessionGoals, no_turn_words};
use crate::driver::codex::run::start::CODEX_TURN_START_TIMEOUT;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::inbound::CodexSessionInboundSender;
use crate::driver::codex::session::slots::CodexSessionSlots;
use crate::driver::codex::session::test_fixture::{
    TEST_THREAD, TestCodexSession, TestDaemonTurnBindings, turn_started,
};
use crate::driver::contract::error::DriverError;
use crate::driver::run_control::{
    DaemonTurnAdmission, DaemonTurnBinding, DaemonTurnBindingError, DaemonTurnBindingResolver,
    DaemonTurnProcess,
};
use crate::driver::session_control::{DriverGoalResult, SetSessionGoalParams};
use crate::driver::test_registry::new_run_id;
use crate::port::run_host::test_host::EngineCall;

/// How long a test waits for a set to settle before it counts it as stuck.
const SET_BOUND: Duration = Duration::from_secs(10);

/// Opens each turn's binding as the fixture's bindings do, once the session's record is up in
/// `slots`, as the queue's open of a session with no process brings it up.
struct OpeningBindings {
    slots: Arc<CodexSessionSlots>,
    inbound: CodexSessionInboundSender,
    bindings: Arc<TestDaemonTurnBindings>,
}

impl DaemonTurnBindingResolver for OpeningBindings {
    fn open_daemon_turn_binding(
        &self,
        run_id: RunId,
        session_id: SessionId,
        process: DaemonTurnProcess,
    ) -> BoxFuture<'_, Result<DaemonTurnBinding, DaemonTurnBindingError>> {
        async move {
            self.slots
                .claim_establishing(session_id)
                .await
                .expect("the session's slot is free")
                .install(self.inbound.clone());
            self.bindings
                .open_daemon_turn_binding(run_id, session_id, process)
                .await
        }
        .boxed()
    }

    fn admit_daemon_turn(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<DaemonTurnAdmission, DaemonTurnBindingError>> {
        self.bindings.admit_daemon_turn(session_id)
    }
}

/// Refuses every daemon turn's admission for want of a current account.
struct RefusingAdmission;

impl DaemonTurnBindingResolver for RefusingAdmission {
    fn open_daemon_turn_binding(
        &self,
        _run_id: RunId,
        session_id: SessionId,
        _process: DaemonTurnProcess,
    ) -> BoxFuture<'_, Result<DaemonTurnBinding, DaemonTurnBindingError>> {
        async move { Err(DaemonTurnBindingError::NoProviderSession { session_id }) }.boxed()
    }

    fn admit_daemon_turn(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<DaemonTurnAdmission, DaemonTurnBindingError>> {
        async move {
            Err(DaemonTurnBindingError::Refused {
                session_id,
                refusal: Box::new(DomainError::new(
                    "no current account".to_owned(),
                    RefusalCode::ProviderAccountCurrentNotSet,
                )),
            })
        }
        .boxed()
    }
}

// A goal on a session with no process answers the admission's refusal as that refusal, and a
// turn the engine holds for another run as the turn-in-flight refusal. Kills: either answered
// as an internal fault.
#[tokio::test]
async fn a_goal_on_a_session_with_no_process_answers_its_refusals() {
    let session = TestCodexSession::start().await;
    let session_id = session.task.record.session_id;
    let goals_over = |bindings: Arc<dyn DaemonTurnBindingResolver>| {
        CodexSessionGoals::new(
            Arc::new(CodexSessionSlots::new()),
            Arc::clone(&session.task.calls.runs.config_forks),
            Arc::clone(&session.run_start),
            Arc::clone(&session.task.run_routes),
            Arc::clone(&session.engine) as _,
            bindings,
        )
    };
    let params = || SetSessionGoalParams {
        session_id,
        goal_text: "ship the checkout fix".to_owned(),
    };

    let refused = goals_over(Arc::new(RefusingAdmission) as _)
        .set(params())
        .await;
    assert!(
        matches!(
            &refused,
            Err(CodexError::Driver(DriverError::Refused(refusal)))
                if refusal.code == RefusalCode::ProviderAccountCurrentNotSet
        ),
        "{refused:?}"
    );

    session.engine.refuse_next_daemon_turns_held(1);
    let held = goals_over(Arc::clone(&session.daemon_turn_bindings) as _)
        .set(params())
        .await;
    assert!(
        matches!(
            &held,
            Err(CodexError::SessionTurnInFlight { session_id: held_session })
                if *held_session == session_id
        ),
        "{held:?}"
    );
}

/// Where a goal set goes: a session with a process, or one the goal's own run opens.
#[derive(Clone, Copy, Debug)]
enum SetPath {
    Open,
    NoProcess,
}

/// Goals on `session` reached as `path` says: through its own slots, or through slots no record
/// holds until the goal's binding brings the session up.
async fn goals_for(session: &TestCodexSession, path: SetPath) -> CodexSessionGoals {
    let (slots, bindings): (_, Arc<dyn DaemonTurnBindingResolver>) = match path {
        SetPath::Open => (
            Arc::clone(&session.slots),
            Arc::clone(&session.daemon_turn_bindings) as _,
        ),
        SetPath::NoProcess => {
            let binding_id = session.record_binding().await;
            session.daemon_turn_bindings.open_on(binding_id);
            let slots = Arc::new(CodexSessionSlots::new());
            let bindings = Arc::new(OpeningBindings {
                slots: Arc::clone(&slots),
                inbound: session.task.record.inbound.clone(),
                bindings: Arc::clone(&session.daemon_turn_bindings),
            });
            (slots, bindings as _)
        }
    };
    CodexSessionGoals::new(
        slots,
        Arc::clone(&session.task.calls.runs.config_forks),
        Arc::clone(&session.run_start),
        Arc::clone(&session.task.run_routes),
        Arc::clone(&session.engine) as _,
        bindings,
    )
}

// Kills: a set refused while a turn runs, which Codex applies to that turn instead; a set that
// leaves a paused or finished goal's status as it was, so no turn works on it.
#[tokio::test]
async fn a_goal_set_while_a_turn_runs_goes_out_at_once() {
    let mut session = TestCodexSession::start().await;
    let run_id = new_run_id();
    session
        .task
        .record
        .add_active_turn("turn-1".to_owned(), run_id);
    let goals = goals_for(&session, SetPath::Open).await;
    let set = goals.set(SetSessionGoalParams {
        session_id: session.task.record.session_id,
        goal_text: "ship the checkout fix".to_owned(),
    });
    let task = &mut session.task;
    let script = &mut session.scripted.script;
    let service = async {
        let read = script.next_sent().await;
        assert_eq!(read["method"], "thread/goal/get");
        script.answer(&read, &json!({ "goal": null }));
        let sent = script.next_sent().await;
        assert_eq!(sent["method"], "thread/goal/set");
        assert_eq!(sent["params"]["threadId"], TEST_THREAD);
        assert_eq!(sent["params"]["objective"], "ship the checkout fix");
        assert_eq!(sent["params"]["origin"], "user");
        assert_eq!(sent["params"]["status"], "active");
        script.answer(&sent, &json!({}));
    };
    let (answered, ()) = tokio::time::timeout(
        SET_BOUND,
        Box::pin(async { tokio::join!(task.drive(set), service) }),
    )
    .await
    .expect("the set settles while the turn runs");

    assert_eq!(
        answered.expect("Codex takes the goal mid-turn"),
        DriverGoalResult::Applied {}
    );
}

// Kills: the turn Codex starts for the goal opening a run of its own beside the goal's (two
// runs for one goal); the goal's run claiming no turn; a set on a session with no process
// sent with no run to open it (the slot holds no record).
#[tokio::test]
async fn a_goal_on_a_session_with_no_process_opens_it_and_its_turn_is_the_goal_run() {
    let mut session = TestCodexSession::start().await;
    let goals = goals_for(&session, SetPath::NoProcess).await;
    let set = goals.set(SetSessionGoalParams {
        session_id: session.task.record.session_id,
        goal_text: "ship the checkout fix".to_owned(),
    });
    let task = &mut session.task;
    let script = &mut session.scripted.script;
    let service = async {
        let read = script.next_sent().await;
        assert_eq!(read["method"], "thread/goal/get");
        script.answer(&read, &json!({ "goal": null }));
        let sent = script.next_sent().await;
        assert_eq!(sent["method"], "thread/goal/set");
        script.answer(&sent, &json!({}));
        // Codex starts the goal's turn by itself once it answered.
        script.send(&turn_started("turn-1"));
    };
    let (answered, ()) = tokio::time::timeout(
        SET_BOUND,
        Box::pin(async { tokio::join!(task.drive(set), service) }),
    )
    .await
    .expect("the set settles once the goal's turn started");

    assert_eq!(
        answered.expect("Codex takes the goal"),
        DriverGoalResult::Applied {}
    );
    let goal_run_id = session
        .engine
        .first_daemon_turn_run()
        .expect("the goal went as a run the daemon started");
    let daemon_turn_runs = session
        .engine
        .calls()
        .into_iter()
        .filter(|call| matches!(call, EngineCall::StartDaemonTurn(_)))
        .count();
    assert_eq!(
        daemon_turn_runs, 1,
        "the turn Codex started opened no run beside the goal's"
    );
    assert_eq!(
        session.task.record.active_turn_run("turn-1"),
        Some(goal_run_id),
        "the goal's run took the turn Codex started"
    );
}

// On a paused clock, which jumps to the earliest timer, so this bound has to outlast the
// turn-start deadline. Kills: a set whose turn never started answered `Applied` on either
// path; Codex's goal left as the refused set made it, or put back other than it was.
#[rstest]
#[case::open_with_a_goal_before(SetPath::Open, true)]
#[case::open_with_no_goal_before(SetPath::Open, false)]
#[case::no_process_with_a_goal_before(SetPath::NoProcess, true)]
#[case::no_process_with_no_goal_before(SetPath::NoProcess, false)]
#[tokio::test(start_paused = true)]
async fn a_goal_set_whose_turn_never_starts_is_not_applied_and_puts_the_goal_back(
    #[case] path: SetPath,
    #[case] had_goal: bool,
) {
    let mut session = TestCodexSession::start().await;
    let goals = goals_for(&session, path).await;
    let set = goals.set(SetSessionGoalParams {
        session_id: session.task.record.session_id,
        goal_text: "ship the checkout fix".to_owned(),
    });
    let previous = had_goal.then(previous_goal);
    let task = &mut session.task;
    let script = &mut session.scripted.script;
    let service = async {
        let read = script.next_sent().await;
        assert_eq!(read["method"], "thread/goal/get");
        assert_eq!(read["params"]["threadId"], TEST_THREAD);
        script.answer(&read, &json!({ "goal": previous }));
        let mut sent = script.next_sent().await;
        if had_goal {
            // A replace clears the goal before it sets the new one.
            assert_eq!(sent["method"], "thread/goal/clear");
            script.answer(&sent, &json!({ "cleared": true }));
            sent = script.next_sent().await;
        }
        assert_eq!(sent["method"], "thread/goal/set");
        script.answer(&sent, &json!({}));
        // Codex starts no turn; the put-back comes once the turn-start deadline passed.
        let restore = script.next_sent().await;
        script.answer(&restore, &json!({}));
        restore
    };
    let bound = CODEX_TURN_START_TIMEOUT * 2;
    let (answered, restore) = tokio::time::timeout(
        bound,
        Box::pin(async { tokio::join!(task.drive(set), service) }),
    )
    .await
    .expect("the set settles once the turn-start deadline passed");

    assert!(
        matches!(
            &answered,
            Ok(DriverGoalResult::Degraded { fallback_action: Some(words) })
                if words.as_str() == no_turn_words()
        ),
        "{answered:?}"
    );
    assert_eq!(restore["params"]["threadId"], TEST_THREAD);
    assert_eq!(restore["params"]["origin"], "user");
    if had_goal {
        assert_eq!(restore["method"], "thread/goal/set");
        assert_eq!(restore["params"]["objective"], "keep the build green");
        assert_eq!(restore["params"]["status"], "paused");
        assert_eq!(restore["params"]["tokenBudget"], 50_000);
    } else {
        assert_eq!(restore["method"], "thread/goal/clear");
    }
}

// The goal a replace finds on the conversation, with usage and a budget of its own.
fn previous_goal() -> Value {
    json!({
        "threadId": TEST_THREAD,
        "objective": "keep the build green",
        "status": "paused",
        "tokenBudget": 50_000,
        "tokensUsed": 1_200,
        "timeUsedSeconds": 30,
        "createdAt": 1,
        "updatedAt": 2,
    })
}

// A replace clears the old goal, then sets the new one with no budget, and draws one row of its
// own, the new goal's; the old goal's last update, which Codex sends as it accounts the turn before
// the clear, draws its row as any update does unless it carries the new goal's text, and a clear
// after the replace draws its own row. Kills: the clear dropped (the new goal inherits the old
// one's usage and budget); the fold dropped or ended on the old goal's update (a cleared row beside
// the update, or the old goal's row twice under the same text); the fold never ended.
#[rstest]
#[case::new_text("ship the checkout fix", 2)]
#[case::the_old_goals_text("keep the build green", 1)]
#[tokio::test]
async fn a_goal_replacing_another_clears_it_first_and_draws_one_row(
    #[case] goal_text: &str,
    #[case] rows_drawn: usize,
) {
    let mut session = TestCodexSession::start().await;
    session
        .task
        .record
        .add_active_turn("turn-1".to_owned(), new_run_id());
    let goals = goals_for(&session, SetPath::Open).await;
    let set = goals.set(SetSessionGoalParams {
        session_id: session.task.record.session_id,
        goal_text: goal_text.to_owned(),
    });
    let task = &mut session.task;
    let script = &mut session.scripted.script;
    let service = async {
        let read = script.next_sent().await;
        assert_eq!(read["method"], "thread/goal/get");
        script.answer(&read, &json!({ "goal": previous_goal() }));
        let clear = script.next_sent().await;
        assert_eq!(clear["method"], "thread/goal/clear");
        assert_eq!(clear["params"]["origin"], "user");
        script.send(&json!({
            "jsonrpc": "2.0",
            "method": "thread/goal/updated",
            "params": {"threadId": TEST_THREAD, "goal": previous_goal()},
        }));
        script.answer(&clear, &json!({ "cleared": true }));
        script.send(&json!({
            "jsonrpc": "2.0",
            "method": "thread/goal/cleared",
            "params": {"threadId": TEST_THREAD},
        }));
        let sent = script.next_sent().await;
        assert_eq!(sent["method"], "thread/goal/set");
        assert_eq!(sent["params"]["objective"], goal_text);
        assert!(sent["params"].get("tokenBudget").is_none(), "{sent}");
        let new_goal = json!({
            "threadId": TEST_THREAD,
            "objective": goal_text,
            "status": "active",
            "tokenBudget": null,
            "tokensUsed": 0,
            "timeUsedSeconds": 0,
            "createdAt": 3,
            "updatedAt": 3,
        });
        script.answer(&sent, &json!({ "goal": new_goal }));
        script.send(&json!({
            "jsonrpc": "2.0",
            "method": "thread/goal/updated",
            "params": {"threadId": TEST_THREAD, "goal": new_goal},
        }));
    };
    let (answered, ()) = tokio::time::timeout(
        SET_BOUND,
        Box::pin(async { tokio::join!(task.drive(set), service) }),
    )
    .await
    .expect("the replace settles while the turn runs");
    assert_eq!(
        answered.expect("Codex takes the new goal"),
        DriverGoalResult::Applied {}
    );
    // The set's update frame may still be on its way once the set answered.
    while !session
        .session_event_payloads()
        .iter()
        .any(|row| row["goal"]["text"] == goal_text && row["status"] == "active")
    {
        session.task.handle_next().await;
    }

    let rows = session.session_event_payloads();
    assert_eq!(rows.len(), rows_drawn, "{rows:?}");
    assert_eq!(rows[0]["goal"]["text"], "keep the build green");
    assert_eq!(rows[rows_drawn - 1]["goal"]["text"], goal_text);
    assert_eq!(rows[rows_drawn - 1]["status"], "active");

    session.scripted.script.send(&json!({
        "jsonrpc": "2.0",
        "method": "thread/goal/cleared",
        "params": {"threadId": TEST_THREAD},
    }));
    session.task.handle_next().await;
    assert_eq!(session.session_event_payloads().len(), rows_drawn + 1);
}

// A set Codex refuses after the replace's clear puts the old goal back with its objective, status
// and budget, and draws no row: neither the clear, nor the old goal's update after the refusal,
// nor the put-back's own; the replace ends on the put-back's update, so a clear after it draws.
// Kills: the put-back's update drawn (the mark not re-marked, or drawn as the new goal's); the old
// goal's update after the refusal drawn (the re-mark taken only after the put-back was sent); the
// mark ended on the old goal's update rather than the put-back's, or never.
#[tokio::test]
async fn a_replace_whose_set_is_refused_puts_the_old_goal_back_and_draws_no_row() {
    let mut session = TestCodexSession::start().await;
    let goals = goals_for(&session, SetPath::Open).await;
    let set = goals.set(SetSessionGoalParams {
        session_id: session.task.record.session_id,
        goal_text: "ship the checkout fix".to_owned(),
    });
    let mut put_back_goal = previous_goal();
    put_back_goal["tokensUsed"] = json!(0);
    put_back_goal["timeUsedSeconds"] = json!(0);
    put_back_goal["createdAt"] = json!(3);
    put_back_goal["updatedAt"] = json!(3);
    let task = &mut session.task;
    let script = &mut session.scripted.script;
    let service = async {
        let read = script.next_sent().await;
        script.answer(&read, &json!({ "goal": previous_goal() }));
        let clear = script.next_sent().await;
        assert_eq!(clear["method"], "thread/goal/clear");
        script.answer(&clear, &json!({ "cleared": true }));
        script.send(&json!({
            "jsonrpc": "2.0",
            "method": "thread/goal/cleared",
            "params": {"threadId": TEST_THREAD},
        }));
        let sent = script.next_sent().await;
        assert_eq!(sent["method"], "thread/goal/set");
        script.send(&json!({
            "jsonrpc": "2.0",
            "id": sent["id"],
            "error": {"code": -32600, "message": "the goal is refused"},
        }));
        script.send(&json!({
            "jsonrpc": "2.0",
            "method": "thread/goal/updated",
            "params": {"threadId": TEST_THREAD, "goal": previous_goal()},
        }));
        let put_back = script.next_sent().await;
        script.answer(&put_back, &json!({ "goal": put_back_goal }));
        script.send(&json!({
            "jsonrpc": "2.0",
            "method": "thread/goal/updated",
            "params": {"threadId": TEST_THREAD, "goal": put_back_goal},
        }));
        put_back
    };
    let (answered, put_back) = tokio::time::timeout(
        SET_BOUND,
        Box::pin(async { tokio::join!(task.drive(set), service) }),
    )
    .await
    .expect("the refused replace settles");

    assert!(
        matches!(&answered, Err(CodexError::ProviderRequest { .. })),
        "{answered:?}"
    );
    assert_eq!(put_back["method"], "thread/goal/set");
    assert_eq!(put_back["params"]["objective"], "keep the build green");
    assert_eq!(put_back["params"]["status"], "paused");
    assert_eq!(put_back["params"]["tokenBudget"], 50_000);
    // A clear after the put-back's update draws only once that update ended the replace.
    session.scripted.script.send(&json!({
        "jsonrpc": "2.0",
        "method": "thread/goal/cleared",
        "params": {"threadId": TEST_THREAD},
    }));
    while session.session_event_payloads().is_empty() {
        session.task.handle_next().await;
    }
    let rows = session.session_event_payloads();
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert!(rows[0].get("goal").is_none(), "{rows:?}");
}

// A turn Codex starts once a goal's run gave its claim back, here a late turn for the refused goal
// landing as the put-back is answered, opens a run of its own once the goal's run ended failed.
// Kills: the claim taken back after the put-back (the goal's run takes the turn and the set
// answers `Applied`); the goal run's ending mark dropped (the turn's run is refused while the
// goal's is live, and the turn interrupted).
#[tokio::test(start_paused = true)]
async fn a_turn_starting_as_a_refused_goal_is_put_back_opens_a_run_of_its_own() {
    let mut session = TestCodexSession::start().await;
    session.engine.refuse_daemon_turns_while_one_starts();
    let goals = goals_for(&session, SetPath::NoProcess).await;
    let params = SetSessionGoalParams {
        session_id: session.task.record.session_id,
        goal_text: "ship the checkout fix".to_owned(),
    };
    let set = tokio::spawn(async move { goals.set(params).await });
    let mut active_goal = previous_goal();
    active_goal["status"] = json!("active");
    let task = &mut session.task;
    let script = &mut session.scripted.script;
    let service = async {
        let read = script.next_sent().await;
        assert_eq!(read["method"], "thread/goal/get");
        script.answer(&read, &json!({ "goal": active_goal }));
        let clear = script.next_sent().await;
        assert_eq!(clear["method"], "thread/goal/clear");
        script.answer(&clear, &json!({ "cleared": true }));
        let sent = script.next_sent().await;
        assert_eq!(sent["method"], "thread/goal/set");
        script.answer(&sent, &json!({}));
        let restore = script.next_sent().await;
        assert_eq!(restore["method"], "thread/goal/set");
        assert_eq!(restore["params"]["status"], "active");
        script.send(&turn_started("turn-1"));
        // The driver reads the turn's start before the put-back is answered.
        tokio::time::sleep(Duration::from_millis(10)).await;
        script.answer(&restore, &json!({}));
    };
    let (answered, ()) = tokio::time::timeout(
        CODEX_TURN_START_TIMEOUT * 3,
        Box::pin(async { tokio::join!(task.drive(set), service) }),
    )
    .await
    .expect("the set settles once the turn-start deadline passed");

    assert!(
        matches!(
            &answered,
            Ok(Ok(DriverGoalResult::Degraded { fallback_action: Some(words) }))
                if words.as_str() == no_turn_words()
        ),
        "{answered:?}"
    );
    let daemon_turn_runs: Vec<RunId> = session
        .engine
        .calls()
        .into_iter()
        .filter_map(|call| match call {
            EngineCall::StartDaemonTurn(run_id) => Some(run_id),
            EngineCall::Deliver(_)
            | EngineCall::StartTurn(..)
            | EngineCall::CountStep(_)
            | EngineCall::RecordTurnEnd(..)
            | EngineCall::RecordDaemonTurnEnd(..)
            | EngineCall::EndTurnOnProcessExit(_)
            | EngineCall::EndTurnOnClose(_) => None,
        })
        .collect();
    assert_eq!(daemon_turn_runs.len(), 2, "{daemon_turn_runs:?}");
    assert_eq!(
        session.task.record.active_turn_run("turn-1"),
        Some(daemon_turn_runs[1]),
        "the turn opened a run of its own, not the goal's"
    );
}
