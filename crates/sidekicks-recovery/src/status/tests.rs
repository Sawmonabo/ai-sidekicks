//! The runs that need the person, as the status read lists them beside the damaged sessions.

use sidekicks_contracts::daemon::recovery::{
    DaemonRecoveryHaltedRun, DaemonRecoverySession, DaemonRecoverySessionState, DaemonRecoveryState,
};
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::run::control::RunFailureCategory;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_run_id, test_session_id};

use super::{LastGoodPoint, RECOVERY_STATUS_STATEMENT_CAPACITY, RecoveryStatusTracker};
use crate::test_pass::insert_runs;

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
        tracker.read(&reads).await.overall,
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

// A halt on a diverged resume that carries no failure.
fn diverged_halt(run_id: RunId) -> DaemonRecoveryHaltedRun {
    DaemonRecoveryHaltedRun {
        run_id,
        recovery_condition: RecoveryCondition::RecoveryNeeded,
        failure_category: None,
    }
}

// A halt whose run has since ended in the store is not listed and the read forgets it, while a
// halt whose run is still live and a failed resume's mark, whose run had ended when it was made,
// stay. Killed by the check skipped, by every halt with a stored run forgotten, and by a failed
// resume's mark checked as a halt.
#[tokio::test]
async fn a_halt_whose_run_ended_is_forgotten() {
    let (database, reads) = test_reads();
    let tracker = RecoveryStatusTracker::new();
    tracker.mark_pass_ended();
    let session = test_session_id();
    let ended = test_run_id();
    let failed = test_run_id();
    let live = test_run_id();
    insert_runs(
        &database,
        session,
        &[
            (ended, "interrupted"),
            (failed, "failed"),
            (live, "waitingForInput"),
        ],
    );
    tracker.mark_run_halted(&session, diverged_halt(ended));
    let failed_resume = DaemonRecoveryHaltedRun {
        run_id: failed,
        recovery_condition: RecoveryCondition::ReauthRequired,
        failure_category: Some(RunFailureCategory::ProviderFailure),
    };
    tracker.mark_run_halted(&session, failed_resume.clone());
    tracker.mark_run_halted(&session, diverged_halt(live));

    let mut listed = vec![failed_resume, diverged_halt(live)];
    listed.sort_by_key(|run| run.run_id);
    assert_eq!(
        entry_of(&tracker, &reads, &session)
            .await
            .and_then(|entry| entry.halted_runs),
        Some(listed)
    );
    assert!(!tracker.lock().halted_runs[&session].contains_key(&ended));
}

// A read that cannot check its halts, through a pool that refuses it or a store that has failed,
// still answers, every halt listed as marked. Killed by the check's failure raised, and by a
// failed store's halts checked.
#[tokio::test]
async fn a_read_that_cannot_check_its_halts_lists_them_as_marked() {
    let (database, reads) = test_reads();
    let tracker = RecoveryStatusTracker::new();
    tracker.mark_pass_ended();
    let session = test_session_id();
    let ended = test_run_id();
    insert_runs(&database, session, &[(ended, "interrupted")]);
    tracker.mark_run_halted(&session, diverged_halt(ended));

    reads.close().await.expect("the test closes the pool");
    let entry = entry_of(&tracker, &reads, &session)
        .await
        .expect("the halted session is listed");
    assert_eq!(entry.state, DaemonRecoverySessionState::Blocked);
    assert_eq!(entry.halted_runs, Some(vec![diverged_halt(ended)]));

    let reads = DatabaseReadPool::new(database.path(), RECOVERY_STATUS_STATEMENT_CAPACITY);
    tracker.mark_store_failed();
    let status = tracker.read(&reads).await;
    assert_eq!(status.overall, DaemonRecoveryState::Blocked);
    assert_eq!(
        status
            .sessions
            .into_iter()
            .find(|session_entry| session_entry.session_id == session)
            .and_then(|session_entry| session_entry.halted_runs),
        Some(vec![diverged_halt(ended)])
    );
}
