//! Whether a continue owes the run's cut work its continuation: only where the restart cut the
//! run's pause, read from the run's newest turn end.

use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use rstest::rstest;
use sidekicks_contracts::run::events::TurnEndCause;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::run_control::ResumeRunOutcome;
use sidekicks_provider::run::turn_end::TurnOutcome;

use super::{WaitingMessages, fixture, waiting_message};

// A continue owes the continuation only while the run's newest turn end is the restart's cut: a
// turn the restart cut and a pause ended since owes nothing, nor does a run with no turn ended.
// Killed by fixing the field `false` (first case) or `true` (the others), by reading the oldest
// end instead of the newest, or by not reading the cause (`paused_since`).
#[rstest]
#[case::cut_by_the_restart(&[(1, Some(TurnEndCause::DaemonRestart))], true)]
#[case::paused_since(&[(1, Some(TurnEndCause::DaemonRestart)), (2, None)], false)]
#[case::no_turn_ended(&[], false)]
#[tokio::test]
async fn a_continue_owes_the_continuation_only_after_the_restart_cut_its_pause(
    #[case] turn_ends: &[(u64, Option<TurnEndCause>)],
    #[case] is_owed: bool,
) {
    let owed = Arc::new(Mutex::new(None::<bool>));
    let recorded = Arc::clone(&owed);
    let mut driver = MockProviderDriver::new();
    driver
        .expect_resume_run()
        .times(1)
        .returning(move |params| {
            *recorded.lock().expect("the field reads") = Some(params.is_continuation_owed);
            async { Ok(ResumeRunOutcome::default()) }.boxed()
        });
    let fixture = fixture(driver, "paused").await;
    for &(turn_number, cause) in turn_ends {
        let turn_number = SafeInt::new(turn_number).expect("the test's turn is a safe integer");
        fixture
            .engine
            .record_daemon_turn_end(fixture.run_id, turn_number, TurnOutcome::Interrupted(cause))
            .await
            .expect("the test ends the turn");
    }
    let messages = WaitingMessages::holding(waiting_message());

    let resumed = fixture.resume(1, &messages).await;

    assert!(resumed.is_ok(), "{resumed:?}");
    assert_eq!(*owed.lock().expect("the field reads"), Some(is_owed));
}
