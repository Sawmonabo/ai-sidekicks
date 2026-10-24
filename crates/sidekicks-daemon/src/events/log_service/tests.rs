//! The event log service's tests, and the test log every test of a log reader opens.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use sidekicks_contracts::session::id::SessionId;
use tokio::sync::oneshot;

use super::{
    EVENT_LOG_STATEMENT_CAPACITY, EventAppendError, EventLogAppendOptions, EventLogService,
    EventLogServiceDependencies, EventReadAfterCursorRequest, UnsequencedEventEnvelope,
};
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::{TestDatabase, test_envelope, test_session_id};
use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions, WritesHeldError};
use crate::events::session::append_lock::SESSION_APPEND_LOCK;
use crate::events::session::appender::{
    SessionEventAppendError, SessionEventAppender, SessionEventDraft, SessionEventLinkage,
};
use crate::events::session::followers::SessionEventFollowers;
use crate::events::session::version::SESSION_EVENT_VERSION;
use sidekicks_contracts::wire::id::mint_uuid_v7;

/// Bounds an append the test expects to answer, so one that waits on a lock fails the test.
const APPEND_WAIT: Duration = Duration::from_secs(5);

/// A test's event log: the service, the writer it appends through and the followers it publishes
/// to.
pub(crate) struct TestLog {
    /// The writer every append goes through.
    pub(crate) writer: Arc<DatabaseWriter>,
    /// The followers each committed write is published to.
    pub(crate) followers: Arc<SessionEventFollowers>,
    /// The service on the test's database.
    pub(crate) service: Arc<EventLogService>,
}

/// The event log on `database`, its writer holding its writes until `writes_held_until` answers,
/// or committing each as it comes when that is `None`.
pub(crate) async fn open_log(
    database: &TestDatabase,
    writes_held_until: Option<oneshot::Receiver<Result<(), WritesHeldError>>>,
) -> TestLog {
    let options = DatabaseWriterOptions {
        writes_held_until,
        ..DatabaseWriterOptions::default()
    };
    open_log_with(database, options).await
}

/// The event log on `database`, its writer opened with `options`.
pub(crate) async fn open_log_with(
    database: &TestDatabase,
    options: DatabaseWriterOptions,
) -> TestLog {
    let writer = Arc::new(
        DatabaseWriter::open(database.opener(), options)
            .await
            .expect("the writer opens its database"),
    );
    let followers = Arc::new(SessionEventFollowers::default());
    let service = Arc::new(EventLogService::new(EventLogServiceDependencies {
        writer: Arc::clone(&writer),
        pool: Arc::new(DatabaseReadPool::new(
            database.path(),
            EVENT_LOG_STATEMENT_CAPACITY,
        )),
        followers: Arc::clone(&followers),
        projection_statements: None,
        refuse_session_write: None,
        read_damaged_from_sequence: None,
    }));
    TestLog {
        writer,
        followers,
        service,
    }
}

/// An `agent.toolCall.invoked` event of `session_id` in the run `run_id`.
fn tool_invoked(session_id: &SessionId, run_id: &str) -> UnsequencedEventEnvelope {
    let event = serde_json::from_value(json!({
        "type": "agent.toolCall.invoked",
        "payload": { "sessionId": session_id, "runId": run_id, "toolName": "Read" },
    }))
    .expect("the test writes a agent.toolCall.invoked event");
    test_envelope(*session_id, &event)
}

/// A completed `agent.toolCall.completed` call of `session_id` in the run `run_id` naming two
/// patched files, with its file list as its body.
fn patch_bearing_completion(
    session_id: &SessionId,
    run_id: &str,
) -> (UnsequencedEventEnvelope, EventLogAppendOptions) {
    let event = serde_json::from_value(json!({
        "type": "agent.toolCall.completed",
        "payload": {
            "sessionId": session_id,
            "runId": run_id,
            "toolName": "edit",
            "toolCallId": "call-1",
            "omittedPatches": [
                { "path": "/repo/a.rs", "size": 2 },
                { "path": "/repo/b.rs", "size": 0 },
            ],
        },
    }))
    .expect("the test writes a tool completion");
    let body = json!({ "files": [
        { "path": "/repo/a.rs", "patch": "@@", "additions": 0, "deletions": 0 },
        { "path": "/repo/b.rs", "unavailable": "absent" },
    ] });
    let options = EventLogAppendOptions {
        content_body: Some(body.to_string()),
        ..EventLogAppendOptions::default()
    };
    (test_envelope(*session_id, &event), options)
}

// Killed by an event published out of commit order or dropped with its caller, and by a
// completion's stored parts published as events of their own.
#[tokio::test]
async fn every_committed_event_is_published_in_commit_order_though_its_caller_left() {
    let database = TestDatabase::new();
    let (release, writes_held_until) = oneshot::channel();
    let TestLog {
        writer,
        followers,
        service,
    } = open_log(&database, Some(writes_held_until)).await;
    let heard = Arc::new(Mutex::new(Vec::new()));
    let _attachment = followers.follow_all({
        let heard = Arc::clone(&heard);
        move |event| {
            heard
                .lock()
                .expect("the test's list is not poisoned")
                .push(event.sequence.get());
            Ok(())
        }
    });
    let session_id = test_session_id();
    let run_id = mint_uuid_v7().to_string();
    // The last is a completion stored with its parts, which follow it at the next sequences.
    let mut appends = [false, false, true].map(|is_completion| {
        let (envelope, options) = if is_completion {
            patch_bearing_completion(&session_id, &run_id)
        } else {
            (
                tool_invoked(&session_id, &run_id),
                EventLogAppendOptions::default(),
            )
        };
        Box::pin(service.append(envelope, options))
    });
    // Polled once each, every write is queued behind the hold.
    for append in &mut appends {
        assert!(futures::poll!(append).is_pending());
    }
    let [first, middle, last] = appends;
    drop(middle);

    release.send(Ok(())).expect("the writer waits on its hold");

    assert_eq!(
        first
            .await
            .expect("the first append commits")
            .sequence
            .get(),
        0
    );
    assert_eq!(
        last.await.expect("the last append commits").sequence.get(),
        2
    );
    assert_eq!(
        *heard.lock().expect("the test's list is not poisoned"),
        [0, 1, 2]
    );
    let stored: i64 = database
        .reader()
        .query_row("SELECT count(*) FROM session_events", [], |row| row.get(0))
        .expect("the test counts the stored rows");
    assert!(stored > 3);
    assert_eq!(writer.close(None).await.expect("the writer closes"), 0);
}

#[tokio::test]
async fn a_session_changes_only_once_its_event_can_be_read() {
    let database = TestDatabase::new();
    let (release, writes_held_until) = oneshot::channel();
    let TestLog {
        writer,
        followers,
        service,
    } = open_log(&database, Some(writes_held_until)).await;
    let session_id = test_session_id();
    let mut change_count = followers.change_count(&session_id);
    let run_id = mint_uuid_v7().to_string();
    let mut appended = Box::pin(service.append(
        tool_invoked(&session_id, &run_id),
        EventLogAppendOptions::default(),
    ));
    assert!(futures::poll!(&mut appended).is_pending());
    assert!(
        !change_count
            .has_changed()
            .expect("the followers keep the count")
    );

    release.send(Ok(())).expect("the writer waits on its hold");
    change_count
        .changed()
        .await
        .expect("the followers keep the count");

    let page = service
        .read_after_cursor(EventReadAfterCursorRequest {
            session_id,
            after_cursor: None,
            limit: None,
        })
        .await
        .expect("the log reads");
    let sequences: Vec<u64> = page
        .events
        .iter()
        .map(|event| event.sequence.get())
        .collect();
    assert_eq!(sequences, [0]);
    assert!(!page.has_more);
    // The run the payload names is the row's own column, which run reads seek on.
    let run_columns: (Option<String>, Option<i64>) = database
        .reader()
        .query_row(
            "SELECT run_id, run_version FROM session_events",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("the test reads the row's run columns");
    assert_eq!(run_columns, (Some(run_id), None));
    assert_eq!(
        appended.await.expect("the append commits").sequence.get(),
        0
    );
    assert_eq!(writer.close(None).await.expect("the writer closes"), 0);
}

#[tokio::test]
async fn an_append_under_a_hold_goes_without_the_lock_and_only_on_the_held_session() {
    let database = TestDatabase::new();
    let TestLog {
        writer, service, ..
    } = open_log(&database, None).await;
    let (held_session_id, other_session_id) = (test_session_id(), test_session_id());
    let run_id = mint_uuid_v7().to_string();
    let hold = SESSION_APPEND_LOCK.acquire(held_session_id).await;

    let refused = tokio::time::timeout(
        APPEND_WAIT,
        service.append_held(
            &hold,
            tool_invoked(&other_session_id, &run_id),
            EventLogAppendOptions::default(),
        ),
    )
    .await
    .expect("the append answers");
    assert!(matches!(
        refused,
        Err(EventAppendError::HoldOfAnotherSession { held_session_id: held, session_id })
            if held == held_session_id && session_id == other_session_id
    ));

    let appended = tokio::time::timeout(
        APPEND_WAIT,
        service.append_held(
            &hold,
            tool_invoked(&held_session_id, &run_id),
            EventLogAppendOptions::default(),
        ),
    )
    .await
    .expect("the append under the hold never waits on the lock it holds")
    .expect("the append commits");
    assert_eq!(appended.sequence.get(), 0);
    drop(hold);
    assert_eq!(writer.close(None).await.expect("the writer closes"), 0);
}

// Killed by deleting the strict re-read of the described payload in `compose_rows`, which would
// store a summary on a `finished` ending that every later strict read of the row refuses.
#[tokio::test]
async fn a_command_ending_is_stored_with_a_summary_only_when_it_failed() {
    let database = TestDatabase::new();
    let TestLog {
        writer, service, ..
    } = open_log(&database, None).await;
    let appender = SessionEventAppender::new(service, SESSION_EVENT_VERSION.clone());
    let session_id = test_session_id();
    let run_id = mint_uuid_v7().to_string();
    let ended = |ending: &str| {
        let event = serde_json::from_value(json!({
            "type": "agent.command.ended",
            "payload": {
                "sessionId": session_id,
                "runId": run_id,
                "commandId": "toolu_01",
                "ending": ending,
                "durationMs": 120_000,
            },
        }))
        .expect("the test writes an agent.command.ended event");
        SessionEventDraft::of_session(session_id, &event)
            .expect("the ending passes its checks without a body")
            .with_content_body("Command timed out after 2 minutes".to_owned())
    };

    let stored = appender
        .append(ended("failed"), SessionEventLinkage::default())
        .await
        .expect("a failed ending keeps the provider's summary");
    assert_eq!(stored.sequence.get(), 0);

    let refused = appender
        .append(ended("finished"), SessionEventLinkage::default())
        .await;
    assert!(
        matches!(
            refused,
            Err(SessionEventAppendError::Append(
                EventAppendError::DescribedPayload(_)
            ))
        ),
        "{refused:?}"
    );
    let rows: i64 = database
        .reader()
        .query_row("SELECT count(*) FROM session_events", [], |row| row.get(0))
        .expect("the test counts the stored rows");
    assert_eq!(rows, 1);
    assert_eq!(writer.close(None).await.expect("the writer closes"), 0);
}
