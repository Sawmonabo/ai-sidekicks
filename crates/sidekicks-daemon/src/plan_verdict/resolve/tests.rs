//! Keep over the artifact test store and a mock driver: two verdicts at once settle the plan once,
//! the entry's refusals reach no driver and write nothing, and a settle the guard refuses answers
//! the state the plan now holds.

use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt as _;
use rstest::rstest;
use sidekicks_artifact::plans::service::test_fixture::Fixture;
use sidekicks_artifact::plans::verdict::{PlanSettleOutcome, PlanSettleVerdict, PlanVerdicts};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::plan::{PlanId, PlanResolveResponse};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_provider::driver::PROVIDERS;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::contract::plan_verdict::PlanVerdictAnswer;
use sidekicks_provider::driver::test_registry::registry_of_first_provider;
use sidekicks_provider::port::plan::mint_plan_id;
use sidekicks_store::database::writer::test_file::{insert_lead, test_session_id};
use tokio::sync::oneshot;

use super::{PlanResolution, PlanResolveError};

/// The fixture with its session's lead on the table's first provider, written before any plan so
/// the plan's events follow the lead's `session.created`.
async fn fixture_with_lead() -> Fixture {
    let fixture = Fixture::new().await;
    insert_lead(
        &fixture.store.database,
        fixture.store.session_id,
        PROVIDERS[0].id,
    );
    fixture
}

/// The resolution over `fixture`'s store, its lead's provider answered by `driver`.
fn resolution(fixture: &Fixture, driver: MockProviderDriver) -> PlanResolution {
    PlanResolution::new(
        Arc::new(PlanVerdicts::new(
            Arc::new(fixture.store.publisher()),
            Arc::clone(&fixture.store.appender),
            Arc::clone(&fixture.store.reads),
        )),
        Arc::clone(&fixture.store.reads),
        Arc::new(registry_of_first_provider(Arc::new(driver))),
        Arc::new(|_: &SessionId| None),
    )
}

fn device(name: &str) -> DeviceId {
    DeviceId::new(name.to_owned()).expect("a test device id")
}

/// The state `plan_id`'s row holds.
fn plan_state(fixture: &Fixture, plan_id: PlanId) -> String {
    fixture
        .store
        .database
        .reader()
        .query_row(
            "SELECT state FROM plans WHERE id = ?1",
            [plan_id.text().as_str()],
            |row| row.get(0),
        )
        .expect("the test reads the plan's state")
}

/// The device each `plan.kept` in the log names, oldest first.
fn kept_devices(fixture: &Fixture) -> Vec<String> {
    let reader = fixture.store.database.reader();
    let mut statement = reader
        .prepare(
            "SELECT json_extract(payload, '$.deviceId') FROM session_events
              WHERE type = 'plan.kept' ORDER BY sequence",
        )
        .expect("the test's read prepares");
    statement
        .query_map([], |row| row.get(0))
        .expect("the test reads the kept events")
        .collect::<rusqlite::Result<_>>()
        .expect("each device reads as text")
}

/// How many `plan.*` events the log holds.
fn plan_event_count(fixture: &Fixture) -> i64 {
    fixture
        .store
        .database
        .reader()
        .query_row(
            "SELECT count(*) FROM session_events WHERE type LIKE 'plan.%'",
            [],
            |row| row.get(0),
        )
        .expect("the test counts the plan events")
}

// Keep A holds the plan's lock inside its driver call while keep B queues behind it; once A
// settles, B reads the plan again under the lock and answers `open` without a driver call. Killed
// by a state read only before the lock (B calls the driver, past `times(1)`), and by a kept event
// whose device is not the caller's.
#[tokio::test]
async fn two_keeps_at_once_settle_the_plan_once_for_the_first_caller() {
    let fixture = fixture_with_lead().await;
    let plan_id = fixture.take(true).await;
    let (entered, driver_entered) = oneshot::channel::<()>();
    let (release, driver_released) = oneshot::channel::<()>();
    let mut driver = MockProviderDriver::new();
    driver.expect_answer_plan().times(1).return_once(move |_| {
        async move {
            entered
                .send(())
                .expect("the test waits for the driver call");
            driver_released
                .await
                .expect("the test releases the driver call");
            Ok(PlanVerdictAnswer::Answered {
                follow_up_message: None,
            })
        }
        .boxed()
    });
    let resolution = resolution(&fixture, driver);
    let lock = resolution.verdicts.plan_lock();

    let (first, second) = tokio::join!(resolution.keep(plan_id, device("device-a")), async {
        driver_entered
            .await
            .expect("the first keep reaches its driver");
        let handles = lock.queue_handle_count(plan_id);
        let (second, ()) = tokio::join!(resolution.keep(plan_id, device("device-b")), async {
            lock.wait_for_queue_past(plan_id, handles).await;
            release
                .send(())
                .expect("the first keep waits on its driver");
        });
        second
    });

    assert_eq!(
        first.expect("the first keep settles"),
        PlanResolveResponse::Open { plan_id }
    );
    assert_eq!(
        second.expect("the second keep answers the settled state"),
        PlanResolveResponse::Open { plan_id }
    );
    assert_eq!(kept_devices(&fixture), vec!["device-a".to_owned()]);
}

/// How the entry's refusal comes about.
enum RefusedPlan {
    /// The plan id names no row.
    Unknown,
    /// The planning session's row reads this state.
    SessionIn(SessionState),
}

// A refusal of the entry reaches no driver (the mock has no expectation, so any call panics) and
// writes nothing. Killed by a missing row read as `open`, the closed check left out (the driver is
// called), and `purgeRequested` answered `session.changeRefused`.
#[rstest]
#[case::unknown_plan(RefusedPlan::Unknown, RefusalCode::PlanNotFound)]
#[case::closed_session(
    RefusedPlan::SessionIn(SessionState::Closed),
    RefusalCode::SessionAlreadyClosed
)]
#[case::purge_requested(
    RefusedPlan::SessionIn(SessionState::PurgeRequested),
    RefusalCode::PlanNotFound
)]
#[tokio::test]
async fn a_refused_keep_sends_nothing_and_writes_nothing(
    #[case] refused: RefusedPlan,
    #[case] code: RefusalCode,
) {
    let fixture = fixture_with_lead().await;
    let plan_id = fixture.take(true).await;
    let kept_id = match refused {
        RefusedPlan::Unknown => mint_plan_id(),
        RefusedPlan::SessionIn(state) => {
            fixture
                .store
                .database
                .reader()
                .execute(
                    "UPDATE sessions SET state = ?1 WHERE id = ?2",
                    [
                        <&'static str>::from(state),
                        fixture.store.session_id.text().as_str(),
                    ],
                )
                .expect("the test moves the planning session");
            plan_id
        }
    };
    let events_before = plan_event_count(&fixture);
    let resolution = resolution(&fixture, MockProviderDriver::new());

    let answer = resolution.keep(kept_id, device("device-a")).await;

    let Err(PlanResolveError::Refused(refusal)) = answer else {
        panic!("the keep is refused, got {answer:?}");
    };
    assert_eq!(refusal.code, code);
    assert_eq!(plan_state(&fixture, plan_id), "waiting");
    assert_eq!(plan_event_count(&fixture), events_before);
}

// A handed-off plan answers its state while another holder keeps its lock, with no driver call.
// Killed by the settled read taken only under the lock: the keep waits on the held lock and the
// timeout fails it.
#[tokio::test]
async fn a_handed_off_plan_answers_without_waiting_for_its_lock() {
    let fixture = fixture_with_lead().await;
    let plan_id = fixture.take(true).await;
    let fresh_session_id = test_session_id();
    let resolution = resolution(&fixture, MockProviderDriver::new());
    let hold = resolution.verdicts.plan_lock().acquire(plan_id).await;
    let settled = resolution
        .verdicts
        .settle(
            &hold,
            fixture.store.session_id,
            PlanSettleVerdict::HandOff { fresh_session_id },
            device("device-a"),
            Vec::new(),
        )
        .await
        .expect("the hand-off settles");
    assert_eq!(settled, PlanSettleOutcome::Settled);

    let answer = tokio::time::timeout(
        Duration::from_secs(10),
        resolution.keep(plan_id, device("device-b")),
    )
    .await
    .expect("the keep answers while the lock is held")
    .expect("the keep answers the plan's state");

    assert_eq!(
        answer,
        PlanResolveResponse::HandedOff {
            plan_id,
            fresh_session_id
        }
    );
    drop(hold);
}

/// What the driver meets when it answers the keep.
enum DriverAnswer {
    /// The run's end reopened the plan before the driver answered.
    PlanReopenedMeanwhile,
    /// The provider's request was already answered or withdrawn; the plan still waits.
    NotHeld,
}

// A plan the run's end reopened while the driver answered makes the guard refuse the settle, and
// keep answers the `open` the row holds with no `plan.kept`; a request no longer held still settles
// a plan that waits. Killed by a refused settle answered as an error, and by `NotHeld` answered as
// an error or leaving the plan waiting.
#[rstest]
#[case::plan_reopened_meanwhile(DriverAnswer::PlanReopenedMeanwhile, 0)]
#[case::not_held(DriverAnswer::NotHeld, 1)]
#[tokio::test]
async fn keep_answers_the_plan_its_driver_left(
    #[case] driver_answer: DriverAnswer,
    #[case] kept_events: usize,
) {
    let fixture = fixture_with_lead().await;
    let plan_id = fixture.take(true).await;
    let mut driver = MockProviderDriver::new();
    match driver_answer {
        DriverAnswer::PlanReopenedMeanwhile => {
            let connection = fixture.store.database.reader();
            driver.expect_answer_plan().times(1).return_once(move |_| {
                connection
                    .execute(
                        "UPDATE plans SET state = 'open' WHERE id = ?1",
                        [plan_id.text().as_str()],
                    )
                    .expect("the test reopens the plan");
                async {
                    Ok(PlanVerdictAnswer::Answered {
                        follow_up_message: None,
                    })
                }
                .boxed()
            });
        }
        DriverAnswer::NotHeld => {
            driver
                .expect_answer_plan()
                .times(1)
                .return_once(|_| async { Ok(PlanVerdictAnswer::NotHeld {}) }.boxed());
        }
    }
    let resolution = resolution(&fixture, driver);

    let answer = resolution
        .keep(plan_id, device("device-a"))
        .await
        .expect("the keep answers the plan's state");

    assert_eq!(answer, PlanResolveResponse::Open { plan_id });
    assert_eq!(plan_state(&fixture, plan_id), "open");
    assert_eq!(kept_devices(&fixture).len(), kept_events);
}
