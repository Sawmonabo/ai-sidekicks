//! A damaged session's two recovery actions, over the pass fixture after a pass left it damaged.

use std::sync::Arc;

use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::session::event_cursor::START_OF_LOG_POSITION;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::recovery::SessionRecoveryRefusedReason;
use tokio_util::sync::CancellationToken;

use super::RecoveryActionError;
use crate::session_write_refusal::refuse_call_naming_session;
use crate::test_pass::PassFixture;
use sidekicks_approval::service::tests::SETTLE_WAIT;
use sidekicks_session::run::engine::tests::stored_run_state;
use sidekicks_session::service::{
    EventsReadAfterSequenceRequest, SESSION_SERVICE_STATEMENT_CAPACITY, SessionService,
};
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::test_session_id;

// A pass leaves a session damaged mid-log beside a healthy one; `Continue from here` then skips
// the damaged events through the head under the hold it took, settles the session's run, its
// pending ask canceled under that hold, and opens it to writes, reads skip the range, and the
// writer counts no live run. Killed by the continue's settle taking the session's append lock
// again, and by the run-end gate's cancel doing so (`approvals/run_blocking.rs`, `hold` passed to
// `cancel_pending_for_run` as `None`), either of which never ends the continue (the gate's
// absence it cannot tell apart from the sweep that would cancel the ask later); and by the
// count's cursor clause deleted (it reads 1 after the pass).
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
    let page = SessionService::new(reads, Arc::new(|_: &SessionId| None))
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
}

// Killed by the two refusal reasons swapped, by a delete that purges a session before refusing
// it, and by a delete that answers done without purging.
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
        damaged_history.delete_damaged_session(session_id).await
    };

    let ended = match ended {
        Ok(()) => ActionEnd::Done,
        Err(RecoveryActionError::NotFound(_)) => ActionEnd::NotFound,
        Err(RecoveryActionError::Refused { reason, .. }) => ActionEnd::Refused(reason),
        Err(failure) => panic!("the action failed: {failure}"),
    };
    assert_eq!(ended, expected);
    let purged = if !is_continue && matches!(expected, ActionEnd::Done) {
        vec![session_id]
    } else {
        Vec::new()
    };
    assert_eq!(
        *fixture
            .purges
            .session_ids
            .lock()
            .expect("no purge panics while it records"),
        purged
    );
}
