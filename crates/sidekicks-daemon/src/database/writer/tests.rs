use std::borrow::Cow;
use std::sync::Arc;
use std::time::Duration;

use rusqlite::Connection;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use crate::database::statement::{StatementBindings, WriteStatement};
use crate::database::writer::messages::{BatchFailure, ThreadRequest, WriteJob, WriteJobOutcome};
use crate::database::writer::test_file::{TestDatabase, session_event_row, test_session_id};
use crate::database::writer::{
    CommittedWrite, DatabaseWriter, DatabaseWriterOptions, PendingWrite, ThreadStop,
    WRITE_QUEUE_CAPACITY, WriteError, WriteOptions, WriterThread, WritesHeldError,
};

/// A read that counts to a million: slow enough that a write running it has not committed when
/// the caller's next step runs, and bounded.
const SLOW_READ_SQL: &str = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c \
                             WHERE x < 1000000) SELECT count(*) FROM c";

/// A read that never ends, in constant memory, until it is interrupted.
const ENDLESS_READ_SQL: &str =
    "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c";

fn statement(sql: &'static str, expected_row_count: Option<usize>) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(sql),
        bindings: StatementBindings::None,
        expected_row_count,
    }
}

fn append(session_id: &SessionId, event_type: SessionEventType) -> WriteJob {
    WriteJob {
        statements: Vec::new(),
        events: vec![session_event_row(session_id, event_type)],
    }
}

async fn open_writer(
    database: &TestDatabase,
    writes_held_until: Option<oneshot::Receiver<Result<(), WritesHeldError>>>,
) -> DatabaseWriter {
    let options = DatabaseWriterOptions {
        writes_held_until,
        on_write_failed: None,
    };
    DatabaseWriter::open(database.opener(), options)
        .await
        .expect("the writer opens its database")
}

fn queue(writer: &DatabaseWriter, job: WriteJob) -> PendingWrite {
    writer
        .enqueue(job, WriteOptions::default(), None)
        .expect("the writer takes the write")
}

fn stored_event_count(database: &TestDatabase) -> i64 {
    database
        .reader()
        .query_row("SELECT count(*) FROM session_events", [], |row| row.get(0))
        .expect("the test counts the stored events")
}

fn sequences(written: Result<CommittedWrite, WriteError>) -> Vec<u64> {
    written
        .expect("the write commits")
        .sequences
        .into_iter()
        .map(SafeInt::get)
        .collect()
}

#[tokio::test]
async fn a_refused_write_rolls_back_alone_and_uses_no_sequence() {
    let database = TestDatabase::new();
    let (release, writes_held_until) = oneshot::channel();
    let writer = open_writer(&database, Some(writes_held_until)).await;
    let session_id = test_session_id();
    // Held, the three writes go out as one batch once released.
    let first = queue(
        &writer,
        append(&session_id, SessionEventType::AssistantMessage),
    );
    let refused = queue(
        &writer,
        WriteJob {
            statements: vec![
                statement(
                    "INSERT INTO projection_cursors (id, session_id, last_sequence, state, \
                     updated_at) VALUES ('marker', 'marker-session', 0, 'stale', 'now')",
                    Some(1),
                ),
                statement(
                    "UPDATE projection_cursors SET state = 'current' WHERE id = 'no-such-cursor'",
                    Some(1),
                ),
            ],
            events: vec![session_event_row(
                &session_id,
                SessionEventType::AssistantMessage,
            )],
        },
    );
    let last = queue(
        &writer,
        append(&session_id, SessionEventType::AssistantMessage),
    );
    release.send(Ok(())).expect("the writer waits on its hold");

    assert_eq!(sequences(first.await), [0]);
    assert!(matches!(
        refused.await,
        Err(WriteError::Refused {
            statement_index: 1,
            row_count: 0
        })
    ));
    assert_eq!(sequences(last.await), [1]);
    let marker_count: i64 = database
        .reader()
        .query_row(
            "SELECT count(*) FROM projection_cursors WHERE id = 'marker'",
            [],
            |row| row.get(0),
        )
        .expect("the test reads the marker");
    assert_eq!(marker_count, 0);
    assert_eq!(writer.close(None).await.expect("the writer closes"), 0);
}

#[tokio::test]
async fn flush_answers_once_a_queued_write_has_committed() {
    let database = TestDatabase::new();
    let writer = open_writer(&database, None).await;
    let session_id = test_session_id();
    let written = queue(
        &writer,
        WriteJob {
            statements: vec![statement(SLOW_READ_SQL, Some(1))],
            events: vec![session_event_row(
                &session_id,
                SessionEventType::AssistantMessage,
            )],
        },
    );

    writer.flush().await;

    assert_eq!(stored_event_count(&database), 1);
    assert_eq!(sequences(written.await), [0]);
    assert_eq!(writer.close(None).await.expect("the writer closes"), 0);
}

#[tokio::test]
async fn a_write_at_the_cap_waits_and_is_stored() {
    let database = TestDatabase::new();
    let (release, writes_held_until) = oneshot::channel();
    let writer = open_writer(&database, Some(writes_held_until)).await;
    let session_id = test_session_id();
    let filling = queue(
        &writer,
        WriteJob {
            statements: Vec::new(),
            events: (0..WRITE_QUEUE_CAPACITY)
                .map(|_| session_event_row(&session_id, SessionEventType::AssistantMessage))
                .collect(),
        },
    );
    let mut thinking = queue(
        &writer,
        append(&session_id, SessionEventType::AssistantThinkingUpdate),
    );
    assert!(futures::poll!(&mut thinking).is_pending());

    release.send(Ok(())).expect("the writer waits on its hold");

    assert_eq!(sequences(filling.await).len(), WRITE_QUEUE_CAPACITY);
    assert_eq!(sequences(thinking.await), [10_000]);
    assert_eq!(stored_event_count(&database), 10_001);
    assert_eq!(writer.close(None).await.expect("the writer closes"), 0);
}

#[tokio::test(start_paused = true)]
async fn a_waited_on_write_skips_the_batch_window() {
    let (requests, mut thread_requests) = mpsc::channel(1);
    let (_exit, exit) = oneshot::channel();
    let interrupt_source = Connection::open_in_memory().expect("an in-memory connection opens");
    let writer = DatabaseWriter::serve(
        WriterThread {
            requests,
            interrupt: interrupt_source.get_interrupt_handle(),
            stop: Arc::new(ThreadStop::new()),
            exit,
            join: None,
        },
        DatabaseWriterOptions::default(),
    );
    let queued_at = Instant::now();
    let written = writer
        .enqueue(
            append(&test_session_id(), SessionEventType::AssistantMessage),
            WriteOptions { is_waited_on: true },
            None,
        )
        .expect("the writer takes the write");

    let Some(ThreadRequest::Batch { jobs, reply }) = thread_requests.recv().await else {
        panic!("the writer sends a batch");
    };

    assert_eq!(Instant::now(), queued_at);
    assert_eq!(jobs.len(), 1);
    reply
        .send(Ok(vec![WriteJobOutcome::Committed {
            statement_results: Vec::new(),
            sequences: vec![SafeInt::ZERO],
        }]))
        .expect("the writer waits on the batch");
    assert_eq!(sequences(written.await), [0]);
}

#[tokio::test]
async fn a_close_at_its_drain_bound_rolls_back_the_batch_in_flight() {
    let database = TestDatabase::new();
    let writer = open_writer(&database, None).await;
    // Sent back to back, the two writes go out as one batch.
    let inserted = queue(
        &writer,
        append(&test_session_id(), SessionEventType::AssistantMessage),
    );
    let endless = queue(
        &writer,
        WriteJob {
            statements: vec![statement(ENDLESS_READ_SQL, None)],
            events: Vec::new(),
        },
    );

    let unfinished = tokio::time::timeout(
        Duration::from_secs(5),
        writer.close(Some(Duration::from_millis(200))),
    )
    .await
    .expect("the close answers soon after its bound")
    .expect("the connection closes");

    assert_eq!(unfinished, 2);
    assert!(matches!(
        inserted.await,
        Err(WriteError::ClosedAtDrainBound)
    ));
    assert!(matches!(endless.await, Err(WriteError::ClosedAtDrainBound)));
    assert_eq!(stored_event_count(&database), 0);
}

#[tokio::test]
async fn sqlite_ending_the_transaction_fails_the_whole_batch() {
    let database = TestDatabase::new();
    let (release, writes_held_until) = oneshot::channel();
    let writer = open_writer(&database, Some(writes_held_until)).await;
    let session_id = test_session_id();
    let written = [
        queue(
            &writer,
            append(&session_id, SessionEventType::AssistantMessage),
        ),
        queue(
            &writer,
            WriteJob {
                statements: vec![statement("ROLLBACK", None)],
                events: Vec::new(),
            },
        ),
        queue(
            &writer,
            append(&session_id, SessionEventType::AssistantMessage),
        ),
    ];
    release.send(Ok(())).expect("the writer waits on its hold");

    for write in written {
        let Err(WriteError::BatchFailed(failure)) = write.await else {
            panic!("every write of the batch fails with it");
        };
        assert!(matches!(
            failure.original(),
            BatchFailure::TransactionEnded { job_index: 1, .. }
        ));
    }
    assert_eq!(stored_event_count(&database), 0);
    assert_eq!(writer.close(None).await.expect("the writer closes"), 0);
}
