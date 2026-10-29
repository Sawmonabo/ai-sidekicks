//! The runs that need the person, as the status read lists them beside the damaged sessions.

use rusqlite::params;
use sidekicks_contracts::daemon::recovery::{
    DaemonRecoveryHaltedRun, DaemonRecoverySession, DaemonRecoverySessionState, DaemonRecoveryState,
};
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::run::control::RunFailureCategory;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_session::run::engine::test_fixture::insert_running_run;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_run_id, test_session_id};

use super::{LastGoodPoint, RECOVERY_STATUS_STATEMENT_CAPACITY, RecoveryStatusTracker};

// A database with the daemon's tables and no run, and the read pool the status read checks halts
// through.
fn test_reads() -> (TestDatabase, DatabaseReadPool) {
    let database = TestDatabase::new(sidekicks_approval::schema::schema_parts());
    drop(database.opener()().expect("the test database opens with its tables"));
    let reads = DatabaseReadPool::new(database.path(), RECOVERY_STATUS_STATEMENT_CAPACITY);
    (database, reads)
}

// The status read's entry for `session_id`, `None` when it is not listed.
async fn entry_of(
    tracker: &RecoveryStatusTracker,
    reads: &DatabaseReadPool,
    session_id: &SessionId,
) -> Option<DaemonRecoverySession> {
    tracker
        .read(reads)
        .await
        .expect("the status reads")
        .sessions
        .into_iter()
        .find(|session| session.session_id == *session_id)
}

// A session with only halted runs reads blocked and refuses nothing, while the daemon reads
// healthy; a damaged session with a halted run keeps its damage and carries the run; a session
// leaves the read with its last settled run, current projections keep it, and a purge drops it.
// Killed by the halts written into the damaged sessions, by `overall` raised for a halt, by
// `blocked` overwriting `degraded`, by an entry kept with an empty list, by current projections
// dropping the halted runs, and by the purge's drop of them deleted.
#[tokio::test]
async fn a_halted_run_lists_its_session_without_refusing_it() {
    let (_database, reads) = test_reads();
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

    assert_eq!(
        tracker
            .read(&reads)
            .await
            .expect("the status reads")
            .overall,
        DaemonRecoveryState::Healthy
    );
    assert_eq!(
        entry_of(&tracker, &reads, &halted).await,
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
    let damaged_entry = entry_of(&tracker, &reads, &damaged)
        .await
        .expect("the damaged session is listed");
    assert_eq!(damaged_entry.state, DaemonRecoverySessionState::Degraded);
    assert_eq!(
        damaged_entry.failure_category,
        Some(RunFailureCategory::ProjectionFailure)
    );
    assert_eq!(damaged_entry.halted_runs, Some(vec![failed_resume.clone()]));
    tracker.mark_run_settled(&damaged, &failed_resume.run_id);
    assert_eq!(
        entry_of(&tracker, &reads, &damaged)
            .await
            .map(|session| session.halted_runs),
        Some(None)
    );

    tracker.mark_run_settled(&halted, &diverged.run_id);
    assert_eq!(
        entry_of(&tracker, &reads, &halted)
            .await
            .and_then(|session| session.halted_runs),
        Some(vec![failed_resume.clone()])
    );
    tracker.mark_run_settled(&halted, &failed_resume.run_id);
    assert_eq!(entry_of(&tracker, &reads, &halted).await, None);

    tracker.mark_run_halted(&halted, diverged.clone());
    tracker.mark_session_healthy(&halted);
    assert_eq!(
        entry_of(&tracker, &reads, &halted)
            .await
            .and_then(|session| session.halted_runs),
        Some(vec![diverged])
    );
    tracker.mark_session_deleted(&halted);
    assert_eq!(entry_of(&tracker, &reads, &halted).await, None);
}

// A halt whose run has since ended in the store is not listed and the read forgets it, while a
// failed resume's mark, whose run had ended when it was made, stays. Killed by the check skipped,
// and by a failed resume's mark checked as a halt.
#[tokio::test]
async fn a_halt_whose_run_ended_is_forgotten() {
    let (database, reads) = test_reads();
    let tracker = RecoveryStatusTracker::new();
    tracker.mark_pass_ended();
    let session = test_session_id();
    let ended = test_run_id();
    let failed = test_run_id();
    for (run_id, run_state) in [(ended, "interrupted"), (failed, "failed")] {
        insert_running_run(&database, session, run_id);
        database
            .reader()
            .execute(
                "UPDATE runs SET state = ?1 WHERE run_id = ?2",
                params![run_state, run_id.text().as_str()],
            )
            .expect("the test ends the run");
    }
    tracker.mark_run_halted(
        &session,
        DaemonRecoveryHaltedRun {
            run_id: ended,
            recovery_condition: RecoveryCondition::RecoveryNeeded,
            failure_category: None,
        },
    );
    let failed_resume = DaemonRecoveryHaltedRun {
        run_id: failed,
        recovery_condition: RecoveryCondition::ReauthRequired,
        failure_category: Some(RunFailureCategory::ProviderFailure),
    };
    tracker.mark_run_halted(&session, failed_resume.clone());

    assert_eq!(
        entry_of(&tracker, &reads, &session)
            .await
            .and_then(|entry| entry.halted_runs),
        Some(vec![failed_resume])
    );
    assert!(!tracker.lock().halted_runs[&session].contains_key(&ended));
}
