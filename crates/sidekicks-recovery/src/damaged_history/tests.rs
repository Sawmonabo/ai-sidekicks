//! A damaged session's two recovery actions, over the pass fixture after a pass left it damaged.

use std::collections::BTreeSet;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use rstest::rstest;
use rusqlite::params;
use serde_json::json;
use sidekicks_approval::service::test_fixture::SETTLE_WAIT;
use sidekicks_contracts::daemon::recovery::DaemonRecoveryHaltedRun;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::control::RunFailureCategory;
use sidekicks_contracts::session::event_cursor::START_OF_LOG_POSITION;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::session::recovery::SessionRecoveryRefusedReason;
use sidekicks_session::run::engine::test_fixture::stored_run_state;
use sidekicks_session::service::{
    EventsReadAfterSequenceRequest, SESSION_SERVICE_STATEMENT_CAPACITY, SessionService,
};
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::{test_run_id, test_session_id};
use tokio_util::sync::CancellationToken;

use super::{RecoveryActionError, SessionDeletion};
use crate::session_write_refusal::refuse_call_naming_session;
use crate::stop_intent::{StopIntent, StopIntentFile};
use crate::test_pass::PassFixture;

// A pass leaves a session damaged mid-log beside a healthy one, a row of its run in the range
// stored at a run version above the run's own; `Continue from here` then skips the damaged events
// through the head under the hold it took, settles the session's run past that version, its
// pending ask canceled under that hold, and opens it to writes, reads skip the range, the
// writer counts no live run, and the halt of the run it ended leaves the status read while a
// failed resume's mark of a run it did not end stays. Killed by the continue forgetting every
// halted run of the session; by the skip's advance of the live runs' versions deleted (the
// settle is then stored below the skipped row's version); by the continue's settle taking the
// session's append lock again, and by the run-end gate's cancel doing so
// (`approvals/run_blocking.rs`, `hold` passed to `cancel_pending_for_run` as `None`), either of
// which never ends the continue (the gate's absence it cannot tell apart from the sweep that
// would cancel the ask later); and by the count's cursor clause deleted (it reads 1 after the
// pass).
#[tokio::test]
async fn continuing_a_damaged_session_skips_its_damage_and_settles_its_runs() {
    let fixture = PassFixture::new().await;
    let (damaged, damaged_run) = fixture.stale_session(3, Some(1)).await;
    let ask = fixture.record_pending_ask(damaged, damaged_run);
    fixture
        .pass(Arc::clone(&fixture.status))
        .run(&CancellationToken::new())
        .await;
    assert_eq!(*fixture.live_runs.borrow(), 0);
    assert_eq!(fixture.state("approval_requests", &ask), "pending");
    fixture.status.mark_run_halted(
        &damaged,
        DaemonRecoveryHaltedRun {
            run_id: damaged_run,
            recovery_condition: RecoveryCondition::RecoveryNeeded,
            failure_category: None,
        },
    );
    let failed_resume = DaemonRecoveryHaltedRun {
        run_id: test_run_id(),
        recovery_condition: RecoveryCondition::ReauthRequired,
        failure_category: Some(RunFailureCategory::ProviderFailure),
    };
    fixture
        .status
        .mark_run_halted(&damaged, failed_resume.clone());
    let skipped_run_version: i64 = 5;
    fixture
        .store
        .database
        .reader()
        .execute(
            "UPDATE session_events SET run_id = ?1, run_version = ?2
              WHERE session_id = ?3 AND sequence = 2",
            params![
                damaged_run.text().as_str(),
                skipped_run_version,
                damaged.text().as_str()
            ],
        )
        .expect("the test files a skipped row under the run");

    tokio::time::timeout(
        SETTLE_WAIT,
        fixture
            .damaged_history()
            .continue_from_last_good_point(damaged),
    )
    .await
    .expect("the continue ends")
    .expect("the session continues");

    let skips = fixture.payloads(&damaged, SessionEventType::SessionDamagedEventsSkipped);
    assert_eq!(skips.len(), 1);
    assert_eq!(
        (&skips[0]["fromSequence"], &skips[0]["toSequence"]),
        (&json!(1), &json!(2))
    );
    assert_eq!(
        stored_run_state(&fixture.store.database, &damaged_run).0,
        "failed"
    );
    let settled_run_version: i64 = fixture
        .store
        .database
        .reader()
        .query_row(
            "SELECT run_version FROM session_events WHERE run_id = ?1 AND type = ?2",
            params![
                damaged_run.text().as_str(),
                SessionEventType::AgentRunFailed.as_str()
            ],
            |row| row.get(0),
        )
        .expect("the run's settle is stored");
    assert!(
        settled_run_version > skipped_run_version,
        "{settled_run_version}"
    );
    assert_eq!(fixture.state("approval_requests", &ask), "canceled");
    assert_eq!(
        fixture
            .payloads(&damaged, SessionEventType::ApprovalCanceled)
            .len(),
        1
    );
    assert!(refuse_call_naming_session(&fixture.status, &damaged, "session.pin").is_ok());
    assert_eq!(fixture.status.read_session_write_refusal(&damaged), None);
    let pinned_before = fixture
        .payloads(&damaged, SessionEventType::SessionPinned)
        .len();
    fixture
        .append(
            damaged,
            json!({
                "type": "session.pinned",
                "payload": {"sessionId": damaged, "at": "2026-01-01T00:00:00.000Z"},
            }),
        )
        .await;
    assert_eq!(
        fixture
            .payloads(&damaged, SessionEventType::SessionPinned)
            .len(),
        pinned_before + 1
    );
    let reads = Arc::new(DatabaseReadPool::new(
        fixture.store.database.path(),
        SESSION_SERVICE_STATEMENT_CAPACITY,
    ));
    let status = fixture.status.read(&reads).await;
    assert_eq!(
        status
            .sessions
            .into_iter()
            .find(|session| session.session_id == damaged)
            .and_then(|session| session.halted_runs),
        Some(vec![failed_resume])
    );
    let page = SessionService::new(
        reads,
        Arc::new(|_: &SessionId| None),
        Arc::new(|_: &ProviderId| None),
    )
    .read_events_after_sequence(EventsReadAfterSequenceRequest {
        session_id: damaged,
        after_sequence: START_OF_LOG_POSITION,
        limit: None,
        event_types: None,
        before_sequence: None,
    })
    .await
    .expect("the session's log reads");
    let sequences: Vec<i64> = page
        .events
        .iter()
        .map(|envelope| i64::from(envelope.sequence))
        .collect();
    assert_eq!(sequences.first(), Some(&0));
    assert!(
        !sequences.contains(&1) && !sequences.contains(&2),
        "{sequences:?}"
    );
    assert_eq!(*fixture.live_runs.borrow(), 0);
}

// `Continue from here` on a damaged session the stop intent names ends its running run
// `interrupted` with `daemonStop`, as the person's Stop does, and drops the session's name while
// the other name stays. Killed by the restart's settle used (the run then ends `failed`), and by
// the name left or the whole file removed.
#[tokio::test]
async fn continue_from_here_under_the_stop_intent_ends_runs_by_the_stop() {
    let fixture = PassFixture::new().await;
    let (damaged, damaged_run) = fixture.stale_session(3, Some(1)).await;
    fixture
        .pass(Arc::clone(&fixture.status))
        .run(&CancellationToken::new())
        .await;
    let stop_intent = StopIntentFile::new(&fixture.store.database.path());
    stop_intent
        .write_whole()
        .await
        .expect("the Stop writes the intent");
    let healthy = fixture.store.session_id;
    stop_intent
        .name_sessions(&StopIntent::Whole, BTreeSet::from([damaged, healthy]))
        .await
        .expect("the intent names both sessions");

    tokio::time::timeout(
        SETTLE_WAIT,
        fixture
            .damaged_history()
            .continue_from_last_good_point(damaged),
    )
    .await
    .expect("the continue ends")
    .expect("the session continues");

    assert_eq!(
        stored_run_state(&fixture.store.database, &damaged_run).0,
        "interrupted"
    );
    let interrupted = fixture.payloads(&damaged, SessionEventType::AgentRunInterrupted);
    assert_eq!(interrupted.len(), 1);
    assert_eq!(interrupted[0]["trigger"], json!("daemonStop"));
    assert_eq!(
        stop_intent.read().await,
        Some(StopIntent::Sessions(BTreeSet::from([healthy])))
    );
}

// How a recovery action ends.
#[derive(Debug, PartialEq, Eq)]
enum ActionEnd {
    Done,
    NotFound,
    Refused(SessionRecoveryRefusedReason),
}

// Which session an action names.
#[derive(Clone, Copy, Debug)]
enum Target {
    Healthy,
    Unknown,
    Unreadable,
    UnfinishedCreate(SessionState),
    // A session whose create never finished, whose purge then finds it left the states it takes.
    FinishedDuringDelete,
}

// Killed by the two refusal reasons swapped, by a delete that purges a session before refusing
// it, by a delete that answers done without purging, by a delete of a session whose create never
// finished, archived or closed since, refused or purged as damaged, by one of a damaged session
// purged as such a create, and by a purge that found the session left its states answered as a
// fault rather than the not-damaged refusal.
#[rstest]
#[case::continue_a_healthy_session(
    Target::Healthy,
    true,
    ActionEnd::Refused(SessionRecoveryRefusedReason::NotDamaged)
)]
#[case::delete_a_healthy_session(
    Target::Healthy,
    false,
    ActionEnd::Refused(SessionRecoveryRefusedReason::NotDamaged)
)]
#[case::continue_an_unknown_session(Target::Unknown, true, ActionEnd::NotFound)]
#[case::delete_an_unknown_session(Target::Unknown, false, ActionEnd::NotFound)]
#[case::continue_an_unreadable_session(
    Target::Unreadable,
    true,
    ActionEnd::Refused(SessionRecoveryRefusedReason::NoReadableEvent)
)]
#[case::delete_an_unreadable_session(Target::Unreadable, false, ActionEnd::Done)]
#[case::continue_an_unfinished_create(
    Target::UnfinishedCreate(SessionState::Provisioning),
    true,
    ActionEnd::Refused(SessionRecoveryRefusedReason::NotDamaged)
)]
#[case::delete_an_unfinished_create(
    Target::UnfinishedCreate(SessionState::Provisioning),
    false,
    ActionEnd::Done
)]
#[case::delete_an_archived_unfinished_create(
    Target::UnfinishedCreate(SessionState::Archived),
    false,
    ActionEnd::Done
)]
#[case::delete_a_closed_unfinished_create(
    Target::UnfinishedCreate(SessionState::Closed),
    false,
    ActionEnd::Done
)]
#[case::delete_a_create_finished_meanwhile(
    Target::FinishedDuringDelete,
    false,
    ActionEnd::Refused(SessionRecoveryRefusedReason::NotDamaged)
)]
#[tokio::test]
async fn a_recovery_action_fits_only_a_damaged_session(
    #[case] target: Target,
    #[case] is_continue: bool,
    #[case] expected: ActionEnd,
) {
    let fixture = PassFixture::new().await;
    let session_id = match target {
        Target::Healthy => fixture.store.session_id,
        Target::Unknown => test_session_id(),
        Target::Unreadable => fixture.stale_session(2, Some(0)).await.0,
        Target::UnfinishedCreate(state) => insert_unfinished_create(&fixture, state),
        Target::FinishedDuringDelete => {
            fixture.purges.is_refusing.store(true, Ordering::SeqCst);
            insert_unfinished_create(&fixture, SessionState::Provisioning)
        }
    };
    fixture
        .pass(Arc::clone(&fixture.status))
        .run(&CancellationToken::new())
        .await;
    let damaged_history = fixture.damaged_history();

    let ended = if is_continue {
        damaged_history
            .continue_from_last_good_point(session_id)
            .await
    } else {
        damaged_history.delete_session(session_id).await
    };

    let ended = match ended {
        Ok(()) => ActionEnd::Done,
        Err(RecoveryActionError::NotFound(_)) => ActionEnd::NotFound,
        Err(RecoveryActionError::Refused { reason, .. }) => ActionEnd::Refused(reason),
        Err(failure) => panic!("the action failed: {failure}"),
    };
    assert_eq!(ended, expected);
    let purged = match target {
        Target::FinishedDuringDelete => vec![(session_id, SessionDeletion::UnfinishedCreate)],
        _ if is_continue || !matches!(expected, ActionEnd::Done) => Vec::new(),
        Target::UnfinishedCreate(_) => vec![(session_id, SessionDeletion::UnfinishedCreate)],
        Target::Healthy | Target::Unknown | Target::Unreadable => {
            vec![(session_id, SessionDeletion::DamagedHistory)]
        }
    };
    assert_eq!(
        *fixture
            .purges
            .deletions
            .lock()
            .expect("no purge panics while it records"),
        purged
    );
}

// A delete of an unfinished create whose purge failed after its mark leaves the session
// `purgeRequested`; pressing `Delete session` again purges it as the first press did. Killed by
// the lookup leaving out `purgeRequested`, which refuses the second press `notDamaged`.
#[tokio::test]
async fn a_second_delete_finishes_an_unfinished_create_a_failed_purge_left_marked() {
    let fixture = PassFixture::new().await;
    let session_id = insert_unfinished_create(&fixture, SessionState::Provisioning);
    fixture
        .pass(Arc::clone(&fixture.status))
        .run(&CancellationToken::new())
        .await;
    let damaged_history = fixture.damaged_history();
    damaged_history
        .delete_session(session_id)
        .await
        .expect("the first press purges it");
    fixture
        .store
        .database
        .reader()
        .execute(
            "UPDATE sessions SET state = ?1 WHERE id = ?2",
            params![
                <&'static str>::from(SessionState::PurgeRequested),
                session_id.text().as_str()
            ],
        )
        .expect("the failed purge leaves its mark");

    damaged_history
        .delete_session(session_id)
        .await
        .expect("the second press purges it again");

    assert_eq!(
        *fixture
            .purges
            .deletions
            .lock()
            .expect("no purge panics while it records"),
        vec![
            (session_id, SessionDeletion::UnfinishedCreate),
            (session_id, SessionDeletion::UnfinishedCreate)
        ]
    );
}

// A session row in `state` whose create never finished: no event of it was ever written.
fn insert_unfinished_create(fixture: &PassFixture, state: SessionState) -> SessionId {
    let session_id = test_session_id();
    let reader = fixture.store.database.reader();
    insert_session_row(&reader, session_id.text().as_str(), None, None);
    reader
        .execute(
            "UPDATE sessions SET state = ?1 WHERE id = ?2",
            params![<&'static str>::from(state), session_id.text().as_str()],
        )
        .expect("the session is left in its state");
    session_id
}
