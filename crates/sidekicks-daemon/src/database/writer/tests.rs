use std::borrow::Cow;
use std::error::Error;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use rstest::rstest;
use rusqlite::Connection;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use tokio::sync::mpsc::error::TryRecvError;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use crate::daemon::scheduler::budget::{Measured, ThreadProcessorTime};
use crate::database::checkpoint::{CheckpointMode, CheckpointResult};
use crate::database::statement::{StatementBindings, WriteStatement};
use crate::database::writer::messages::{
    BatchAnswer, BatchFailure, CheckpointReport, ThreadExit, ThreadRequest, WriteJob,
    WriteJobOutcome,
};
use crate::database::writer::test_file::{TestDatabase, session_event_row, test_session_id};
use crate::database::writer::{
    CommittedWrite, DatabaseWriter, DatabaseWriterOptions, MaintenanceError, PendingWrite,
    ThreadStop, WRITE_QUEUE_CAPACITY, WriteError, WriteFailureListener, WriterThread,
    WritesHeldError,
};

/// A read that counts to a million: slow enough that a write running it has not committed when
/// the caller's next step runs, and bounded.
const SLOW_READ_SQL: &str = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c \
                             WHERE x < 1000000) SELECT count(*) FROM c";

/// A write that never ends, in constant memory, until it is interrupted: its insert waits on a
/// count that never finishes.
const ENDLESS_WRITE_SQL: &str = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) \
                                 INSERT INTO projection_cursors (id, session_id, last_sequence, \
                                 state, updated_at) SELECT 'endless', 'endless', count(*), \
                                 'stale', 'now' FROM c";

fn statement(sql: &'static str, expected_row_count: Option<usize>) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(sql),
        bindings: StatementBindings::None,
        expected_row_count,
    }
}

fn append(session_id: &SessionId) -> WriteJob {
    WriteJob {
        statements: Vec::new(),
        events: vec![session_event_row(session_id)],
    }
}

async fn open_writer(
    database: &TestDatabase,
    writes_held_until: Option<oneshot::Receiver<Result<(), WritesHeldError>>>,
    on_write_failed: Option<WriteFailureListener>,
) -> DatabaseWriter {
    let options = DatabaseWriterOptions {
        writes_held_until,
        on_write_failed,
    };
    DatabaseWriter::open(database.opener(), options)
        .await
        .expect("the writer opens its database")
}

/// A listener that counts the failures it hears.
fn counting_listener() -> (Arc<AtomicUsize>, WriteFailureListener) {
    let heard = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&heard);
    let listener: WriteFailureListener = Box::new(move |_failure: &(dyn Error + 'static)| {
        counter.fetch_add(1, Ordering::Relaxed);
    });
    (heard, listener)
}

/// A writer whose thread the test stands in for: it receives each request the thread would. The
/// writer serves while the returned exit sender lives.
fn stand_in_writer(
    options: DatabaseWriterOptions,
) -> (
    DatabaseWriter,
    mpsc::Receiver<ThreadRequest>,
    oneshot::Sender<ThreadExit>,
) {
    let (requests, thread_requests) = mpsc::channel(1);
    let (exit, exited) = oneshot::channel();
    let interrupt_source = Connection::open_in_memory().expect("an in-memory connection opens");
    let writer = DatabaseWriter::serve(
        WriterThread {
            requests,
            interrupt: interrupt_source.get_interrupt_handle(),
            stop: Arc::new(ThreadStop::new()),
            exit: exited,
            join: None,
        },
        options,
    );
    (writer, thread_requests, exit)
}

fn queue(writer: &DatabaseWriter, job: WriteJob) -> PendingWrite {
    writer
        .enqueue(job, None)
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
    let writer = open_writer(&database, Some(writes_held_until), None).await;
    let session_id = test_session_id();
    // Held, the three writes go out as one batch once released.
    let first = queue(&writer, append(&session_id));
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
            events: vec![session_event_row(&session_id)],
        },
    );
    let last = queue(&writer, append(&session_id));
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
    let writer = open_writer(&database, None, None).await;
    let session_id = test_session_id();
    let written = queue(
        &writer,
        WriteJob {
            statements: vec![statement(SLOW_READ_SQL, Some(1))],
            events: vec![session_event_row(&session_id)],
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
    let writer = open_writer(&database, Some(writes_held_until), None).await;
    let session_id = test_session_id();
    let filling = queue(
        &writer,
        WriteJob {
            statements: Vec::new(),
            events: (0..WRITE_QUEUE_CAPACITY)
                .map(|_| session_event_row(&session_id))
                .collect(),
        },
    );
    let mut thinking = queue(&writer, append(&session_id));
    assert!(futures::poll!(&mut thinking).is_pending());

    release.send(Ok(())).expect("the writer waits on its hold");

    assert_eq!(sequences(filling.await).len(), WRITE_QUEUE_CAPACITY);
    assert_eq!(sequences(thinking.await), [10_000]);
    assert_eq!(stored_event_count(&database), 10_001);
    assert_eq!(writer.close(None).await.expect("the writer closes"), 0);
}

/// Answers a batch as committed, each of its writes' one row at the next of `sequences`.
fn commit_each(reply: oneshot::Sender<BatchAnswer>, sequences: std::ops::Range<u64>) {
    let outcomes = sequences
        .map(|sequence| WriteJobOutcome::Committed {
            statement_results: Vec::new(),
            sequences: vec![SafeInt::new(sequence).expect("a test sequence is a safe integer")],
        })
        .collect();
    reply
        .send(Ok(outcomes))
        .expect("the writer waits on the batch");
}

#[tokio::test(start_paused = true)]
async fn a_lone_write_goes_at_once_and_writes_queued_during_a_commit_form_the_next_batch() {
    let (writer, mut thread_requests, _exit) = stand_in_writer(DatabaseWriterOptions::default());
    let session_id = test_session_id();
    let queued_at = Instant::now();
    let lone = queue(&writer, append(&session_id));
    let Some(ThreadRequest::Batch { jobs, reply }) = thread_requests.recv().await else {
        panic!("the writer sends a batch");
    };
    assert_eq!(Instant::now(), queued_at);
    assert_eq!(jobs.len(), 1);

    // Queued while the first batch commits, the next writes wait for it and then go together.
    let later: Vec<PendingWrite> = (0..3)
        .map(|_| queue(&writer, append(&session_id)))
        .collect();
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
    assert!(matches!(
        thread_requests.try_recv(),
        Err(TryRecvError::Empty)
    ));
    commit_each(reply, 0..1);
    let Some(ThreadRequest::Batch { jobs, reply }) = thread_requests.recv().await else {
        panic!("the writer sends the next batch");
    };
    assert_eq!(jobs.len(), 3);
    commit_each(reply, 1..4);
    assert_eq!(sequences(lone.await), [0]);
    for (expected, written) in (1..4).zip(later) {
        assert_eq!(sequences(written.await), [expected]);
    }
}

#[tokio::test]
async fn no_checkpoint_runs_while_the_writer_holds_its_writes() {
    let (release, writes_held_until) = oneshot::channel();
    let (writer, mut thread_requests, _exit) = stand_in_writer(DatabaseWriterOptions {
        writes_held_until: Some(writes_held_until),
        on_write_failed: None,
    });
    let mut truncating = Box::pin(writer.checkpoint(CheckpointMode::Truncate));
    assert!(futures::poll!(&mut truncating).is_pending());

    // The flush answers once the queue has taken the checkpoint.
    writer.flush().await;

    assert!(matches!(
        thread_requests.try_recv(),
        Err(TryRecvError::Empty)
    ));
    assert!(matches!(
        writer.checkpoint(CheckpointMode::Passive).await,
        Err(MaintenanceError::Held)
    ));
    release.send(Ok(())).expect("the writer waits on its hold");
    let Some(ThreadRequest::Checkpoint {
        mode: CheckpointMode::Truncate,
        reply,
    }) = thread_requests.recv().await
    else {
        panic!("the writer sends the truncating checkpoint once the hold is let go");
    };
    let result = CheckpointResult {
        is_busy: false,
        log_frames: 0,
        checkpointed_frames: 0,
    };
    reply
        .send(Ok(Measured {
            report: CheckpointReport {
                result,
                page_size: 4096,
            },
            processor_time: ThreadProcessorTime::default(),
        }))
        .expect("the writer waits on the checkpoint");
    assert_eq!(truncating.await.expect("the checkpoint runs"), result);
}

#[tokio::test]
async fn a_close_at_its_drain_bound_rolls_back_the_batch_in_flight() {
    let database = TestDatabase::new();
    let (failures_heard, on_write_failed) = counting_listener();
    let writer = open_writer(&database, None, Some(on_write_failed)).await;
    // Sent back to back, the two writes go out as one batch.
    let inserted = queue(&writer, append(&test_session_id()));
    let endless = queue(
        &writer,
        WriteJob {
            statements: vec![statement(ENDLESS_WRITE_SQL, None)],
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
    // The stop's own interrupt says nothing of the file.
    assert_eq!(failures_heard.load(Ordering::Relaxed), 0);
}

#[rstest]
#[case::rollback(None, &[("ROLLBACK", None)], true, 1)]
#[case::rollback_then_refused(
    None,
    &[
        ("ROLLBACK", None),
        ("UPDATE projection_cursors SET state = 'current' WHERE id = 'no-such-cursor'", Some(1)),
    ],
    false,
    1,
)]
#[case::after_a_write_failed_alone(
    Some("SELECT * FROM no_such_table"),
    &[("ROLLBACK", None)],
    true,
    2,
)]
#[tokio::test]
async fn sqlite_ending_the_transaction_fails_the_whole_batch(
    #[case] first_statement: Option<&'static str>,
    #[case] middle_statements: &'static [(&'static str, Option<usize>)],
    #[case] has_source: bool,
    #[case] expected_failures_heard: usize,
) {
    let database = TestDatabase::new();
    let (release, writes_held_until) = oneshot::channel();
    let (failures_heard, on_write_failed) = counting_listener();
    let writer = open_writer(&database, Some(writes_held_until), Some(on_write_failed)).await;
    let session_id = test_session_id();
    let first = match first_statement {
        Some(sql) => WriteJob {
            statements: vec![statement(sql, None)],
            events: Vec::new(),
        },
        None => append(&session_id),
    };
    let middle = WriteJob {
        statements: middle_statements
            .iter()
            .map(|&(sql, expected_row_count)| statement(sql, expected_row_count))
            .collect(),
        events: Vec::new(),
    };
    let written = [
        queue(&writer, first),
        queue(&writer, middle),
        queue(&writer, append(&session_id)),
    ];
    release.send(Ok(())).expect("the writer waits on its hold");

    for write in written {
        let Err(WriteError::BatchFailed(failure)) = write.await else {
            panic!("every write of the batch fails with it");
        };
        let BatchFailure::TransactionEnded {
            job_index: 1,
            source,
        } = failure.original()
        else {
            panic!("SQLite ended the transaction while the middle write ran");
        };
        assert_eq!(source.is_some(), has_source);
    }
    assert_eq!(stored_event_count(&database), 0);
    assert_eq!(
        failures_heard.load(Ordering::Relaxed),
        expected_failures_heard
    );
    assert_eq!(writer.close(None).await.expect("the writer closes"), 0);
}
