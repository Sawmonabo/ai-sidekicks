//! A resume while an undo holds the run's session, and the wait for a call on a run under way.

use std::pin::pin;
use std::sync::atomic::Ordering;

use rstest::rstest;
use sidekicks_contracts::run::control::AgentRunResumeRequest;
use sidekicks_contracts::run::state::RunState;
use sidekicks_provider::driver::contract::MockProviderDriver;
use tokio::time::timeout;

use super::{
    HELD_WATCH, SETTLE_WAIT, WaitingMessages, fixture, hold_resume, safe, waiting_message,
};

// A resume whose read finds the session held for an undo answers the run as it stands, its state
// and version unchanged, and asks no driver: the run's row stays as it was and its message waits,
// neither kept nor given back. Killed by reading the held answer as an empty list of messages (the
// driver is resumed with none, which this driver refuses to take), and by writing `running` on a
// held resume (the row and the answer move).
#[rstest]
#[case::paused("paused", RunState::Paused)]
#[case::pausing("pausing", RunState::Pausing)]
#[tokio::test]
async fn a_resume_held_for_an_undo_answers_the_runs_state_and_calls_no_driver(
    #[case] stored_state: &str,
    #[case] state: RunState,
) {
    let mut driver = MockProviderDriver::new();
    driver.expect_resume_run().times(0);
    let fixture = fixture(driver, stored_state).await;
    let messages = WaitingMessages {
        is_held_for_undo: true,
        ..WaitingMessages::holding(waiting_message())
    };

    let resumed = fixture
        .control
        .resume(
            &AgentRunResumeRequest {
                target_run_id: fixture.run_id,
                expected_run_version: safe(1),
            },
            &messages,
        )
        .await
        .expect("a held resume answers");

    assert_eq!(resumed.response.run_id, fixture.run_id);
    assert_eq!(resumed.response.new_state, state);
    assert_eq!(resumed.response.run_version, safe(1));
    assert!(!resumed.is_hold_lost);
    assert_eq!(fixture.run(), (stored_state.to_owned(), 1));
    assert_eq!(messages.waiting.lock().expect("the messages read").len(), 1);
    assert_eq!(messages.kept_messages(), []);
    assert_eq!(messages.releases.load(Ordering::SeqCst), 0);
    assert_eq!(messages.admissions.load(Ordering::SeqCst), 0);
}

// The wait for a run's calls returns only once a resume inside its driver call has landed, the run
// then reading `running`. Killed by a wait that does not take the run's lock (it returns while the
// driver call is held, and the run still reads `paused`).
#[tokio::test]
async fn waiting_out_a_runs_calls_returns_once_a_resume_under_way_has_landed() {
    let mut driver = MockProviderDriver::new();
    let held = hold_resume(&mut driver);
    let fixture = fixture(driver, "paused").await;
    let messages = WaitingMessages::default();

    let resuming = fixture.resume(1, &messages);
    let waiting = async {
        timeout(SETTLE_WAIT, held.started)
            .await
            .expect("the driver is asked to resume")
            .expect("the driver signals its call");
        let mut wait = pin!(fixture.control.wait_out_calls(fixture.run_id));
        let is_waiting_while_held = timeout(HELD_WATCH, &mut wait).await.is_err();
        held.answer
            .send(Ok(()))
            .expect("the resume waits for its answer");
        timeout(SETTLE_WAIT, wait)
            .await
            .expect("the wait returns once the resume landed");
        (is_waiting_while_held, fixture.run())
    };
    let (resumed, (is_waiting_while_held, run_after_wait)) = tokio::join!(resuming, waiting);

    assert!(resumed.is_ok(), "{resumed:?}");
    assert!(is_waiting_while_held);
    assert_eq!(run_after_wait, ("running".to_owned(), 2));
}
