//! The runs that need the person, as the status read lists them beside the damaged sessions.

use sidekicks_contracts::daemon::recovery::{
    DaemonRecoveryHaltedRun, DaemonRecoverySession, DaemonRecoverySessionState, DaemonRecoveryState,
};
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::run::control::RunFailureCategory;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_store::database::writer::test_file::{test_run_id, test_session_id};

use super::{LastGoodPoint, RecoveryStatusTracker};

// The status read's entry for `session_id`, `None` when it is not listed.
fn entry_of(
    tracker: &RecoveryStatusTracker,
    session_id: &SessionId,
) -> Option<DaemonRecoverySession> {
    tracker
        .read()
        .sessions
        .into_iter()
        .find(|session| session.session_id == *session_id)
}

// A session with only halted runs reads blocked and refuses nothing, while the daemon reads
// healthy; a damaged session with a halted run keeps its damage and carries the run; a session
// leaves the read with its last settled run, and a purge drops it. Killed by the halts written
// into the damaged sessions, by `overall` raised for a halt, by `blocked` overwriting `degraded`,
// by an entry kept with an empty list, and by the purge's drop of the halted runs deleted.
#[test]
fn a_halted_run_lists_its_session_without_refusing_it() {
    let tracker = RecoveryStatusTracker::new();
    tracker.mark_pass_ended();
    let halted = test_session_id();
    let diverged = DaemonRecoveryHaltedRun {
        run_id: test_run_id(),
        recovery_condition: RecoveryCondition::RecoveryNeeded,
        failure_category: None,
    };
    let failed_resume = DaemonRecoveryHaltedRun {
        run_id: test_run_id(),
        recovery_condition: RecoveryCondition::ReauthRequired,
        failure_category: Some(RunFailureCategory::ProviderFailure),
    };
    tracker.mark_run_halted(&halted, diverged.clone());
    tracker.mark_run_halted(&halted, failed_resume.clone());

    // The runs are listed in run id order.
    let mut halted_runs = vec![diverged.clone(), failed_resume.clone()];
    halted_runs.sort_by_key(|run| run.run_id);

    assert_eq!(tracker.read().overall, DaemonRecoveryState::Healthy);
    assert_eq!(
        entry_of(&tracker, &halted),
        Some(DaemonRecoverySession {
            session_id: halted,
            state: DaemonRecoverySessionState::Blocked,
            last_applied_sequence: None,
            last_applied_at: None,
            damaged_from_sequence: None,
            failure_category: None,
            recovery_condition: None,
            halted_runs: Some(halted_runs),
        })
    );
    assert_eq!(tracker.read_session_write_refusal(&halted), None);
    assert_eq!(tracker.read_session_call_refusal(&halted), None);
    assert_eq!(tracker.read_session_append_refusal(&halted), None);

    let damaged = test_session_id();
    tracker.mark_session_at_last_good_point(
        &damaged,
        LastGoodPoint {
            last_sequence: SafeInt::new(4).expect("4 is a safe integer"),
            last_occurred_at: WireInstant::try_from("2026-10-14T09:30:00.000Z".to_owned())
                .expect("the instant is well formed"),
            damaged_from_sequence: SafeInt::new(5).expect("5 is a safe integer"),
        },
    );
    tracker.mark_run_halted(&damaged, failed_resume.clone());
    let damaged_entry = entry_of(&tracker, &damaged).expect("the damaged session is listed");
    assert_eq!(damaged_entry.state, DaemonRecoverySessionState::Degraded);
    assert_eq!(
        damaged_entry.failure_category,
        Some(RunFailureCategory::ProjectionFailure)
    );
    assert_eq!(damaged_entry.halted_runs, Some(vec![failed_resume.clone()]));
    tracker.mark_run_settled(&damaged, &failed_resume.run_id);
    assert_eq!(
        entry_of(&tracker, &damaged).map(|session| session.halted_runs),
        Some(None)
    );

    tracker.mark_run_settled(&halted, &diverged.run_id);
    assert_eq!(
        entry_of(&tracker, &halted).and_then(|session| session.halted_runs),
        Some(vec![failed_resume.clone()])
    );
    tracker.mark_run_settled(&halted, &failed_resume.run_id);
    assert_eq!(entry_of(&tracker, &halted), None);

    tracker.mark_run_halted(&halted, diverged);
    tracker.mark_session_healthy(&halted);
    assert_eq!(entry_of(&tracker, &halted), None);
}
