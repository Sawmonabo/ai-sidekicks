//! The online copy on the writer's thread: writes served between its steps, the commit count it
//! names, a lock met and waited out, the lock's bound, and the copy's cancel.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc as std_mpsc;
use std::time::Duration;

use rusqlite::Connection;
use rusqlite::types::Value;
use tokio::runtime::Handle;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use super::{
    BackupAnswer, BackupCopy, BackupLock, CopyOrder, LOCK_BOUND, ThreadServing, copy_database,
};
use crate::database::checkpoint::CheckpointMode;
use crate::database::connection::writer_open::open_database;
use crate::database::statement::{StatementBindings, WriteStatement};
use crate::database::writer::messages::{MeasuredCheckpointAnswer, ThreadRequest, WriteJob};
use crate::database::writer::test_file::TestDatabase;
use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions, ThreadStop};
use crate::events::content::codec::BodyEncoder;

// How long a test waits for an answer that must come.
const WAIT: Duration = Duration::from_secs(10);

// How long a copy held by a lock is watched to show it waits rather than ends.
const HELD_SPAN: Duration = Duration::from_millis(300);

fn write_statement(sql: &str) -> WriteStatement {
    WriteStatement {
        sql: sql.to_owned().into(),
        bindings: StatementBindings::Positional(Vec::new()),
        expected_row_count: None,
    }
}

// A database of about 600 pages, so a copy takes several steps.
fn filled_database() -> TestDatabase {
    let database = TestDatabase::new();
    open_database(&database.path())
        .expect("the store opens")
        .execute_batch(
            "CREATE TABLE filler (id INTEGER PRIMARY KEY, body BLOB);
             WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600)
             INSERT INTO filler SELECT i, zeroblob(4000) FROM n;",
        )
        .expect("the filler is written");
    database
}

// Runs one copy of the store at `source` into `destination` on a blocking thread, as the writer's
// thread does, answering on the returned channel.
fn start_copy(
    source: PathBuf,
    destination: PathBuf,
    cancel: CancellationToken,
    lock_bound: Duration,
    mut requests: mpsc::Receiver<ThreadRequest>,
) -> std_mpsc::Receiver<(BackupAnswer, bool)> {
    let (answer, answered) = std_mpsc::channel();
    let runtime = Handle::current();
    tokio::task::spawn_blocking(move || {
        let connection = open_database(&source).expect("the writer's connection opens");
        let order = CopyOrder {
            destination: &destination,
            cancel: &cancel,
            lock_bound,
        };
        let stop = ThreadStop::new();
        let mut commit_count = 0;
        let mut serving = ThreadServing {
            connection: &connection,
            encoder: &mut BodyEncoder::new(),
            requests: &mut requests,
            stop: &stop,
            runtime: &runtime,
            commit_count: &mut commit_count,
        };
        answer
            .send(copy_database(&order, &mut serving))
            .expect("the test waits for the copy");
    });
    answered
}

// A connection holding the destination's file under an exclusive lock, so each step meets it.
fn lock_destination(destination: &Path) -> Connection {
    let blocker = Connection::open(destination).expect("the destination opens");
    blocker
        .execute_batch("BEGIN EXCLUSIVE")
        .expect("the destination is locked");
    blocker
}

fn checkpoint_request() -> (ThreadRequest, oneshot::Receiver<MeasuredCheckpointAnswer>) {
    let (reply, answer) = oneshot::channel();
    (
        ThreadRequest::Checkpoint {
            mode: CheckpointMode::Passive,
            reply,
        },
        answer,
    )
}

// A write and a checkpoint queued while the copy steps are served between its steps: the write
// lands in the copy, which passes SQLite's whole check, and the copy took no more steps than its
// pages need, so neither restarted it. Both answers are there when the copy returns, so a copy
// that served nothing fails at once rather than hang. Killed by `run_to_completion` and by a write
// through a second connection, which restarts the copy.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_write_made_during_the_copy_lands_in_it_without_restarting_it() {
    let database = filled_database();
    let (sender, requests) = mpsc::channel(4);
    let (batch_reply, mut batch_answer) = oneshot::channel();
    sender
        .try_send(ThreadRequest::Batch {
            jobs: vec![WriteJob {
                statements: vec![
                    write_statement("UPDATE filler SET body = zeroblob(10) WHERE id = 1"),
                    write_statement("INSERT INTO filler VALUES (100000, 'during the copy')"),
                ],
                events: Vec::new(),
            }],
            reply: batch_reply,
        })
        .expect("the write is queued");
    let (checkpoint, mut checkpoint_answer) = checkpoint_request();
    sender
        .try_send(checkpoint)
        .expect("the checkpoint is queued");
    let destination = database.path().with_file_name("copy.db");

    let (answer, is_queue_gone) = start_copy(
        database.path(),
        destination.clone(),
        CancellationToken::new(),
        LOCK_BOUND,
        requests,
    )
    .recv_timeout(WAIT)
    .expect("the copy answers");

    let copied = answer.expect("the copy succeeds").report;
    let BackupCopy::Copied {
        page_count,
        step_count,
        ..
    } = copied
    else {
        panic!("the copy finished, not {copied:?}");
    };
    assert!(!is_queue_gone);
    assert!(
        batch_answer
            .try_recv()
            .expect("served during the copy")
            .is_ok()
    );
    assert!(
        checkpoint_answer
            .try_recv()
            .expect("served during the copy")
            .is_ok()
    );
    let pages_per_step = 100;
    assert!(step_count > 2, "the copy took several steps");
    assert!(
        step_count <= u64::try_from(page_count / pages_per_step + 1).expect("a count"),
        "{step_count} steps for {page_count} pages"
    );
    let copy = Connection::open(&destination).expect("the copy opens");
    let check: String = copy
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .expect("the copy is checked");
    assert_eq!(check, "ok");
    let written: String = copy
        .query_row("SELECT body FROM filler WHERE id = 100000", [], |row| {
            row.get(0)
        })
        .expect("the write made during the copy is in it");
    assert_eq!(written, "during the copy");
}

// While the copy steps, writes sent back to back land in it up to the step that finishes it and
// not after, and the count it answers covers exactly the writes it holds, each write its own
// batch. Killed by a count read anywhere but the thread at the finishing step, which takes in
// the writes served after it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_copy_holds_exactly_the_writes_its_commit_count_covers() {
    const WRITE_COUNT: i64 = 200;
    const FIRST_WRITTEN_ID: i64 = 1_000_000;
    let database = filled_database();
    let writer = Arc::new(
        DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens"),
    );
    let write = |id: i64| WriteStatement {
        sql: "INSERT INTO filler VALUES (?1, 'during the copy')".into(),
        bindings: StatementBindings::Positional(vec![Value::Integer(id)]),
        expected_row_count: Some(1),
    };
    writer
        .write(vec![write(FIRST_WRITTEN_ID + 1)])
        .await
        .expect("the first write commits");
    let writing = tokio::spawn({
        let writer = Arc::clone(&writer);
        async move {
            for id in FIRST_WRITTEN_ID + 2..=FIRST_WRITTEN_ID + WRITE_COUNT {
                writer
                    .write(vec![write(id)])
                    .await
                    .expect("the write commits");
            }
        }
    });
    let destination = database.path().with_file_name("copy.db");

    let copied = writer
        .backup(destination.clone(), CancellationToken::new())
        .await
        .expect("the copy answers")
        .report;
    writing.await.expect("the writes end");

    let BackupCopy::Copied { copied_through, .. } = copied else {
        panic!("the copy finished, not {copied:?}");
    };
    let copy = Connection::open(&destination).expect("the copy opens");
    let held: Vec<i64> = copy
        .prepare("SELECT id FROM filler WHERE id > ?1 ORDER BY id")
        .and_then(|mut statement| {
            statement
                .query_map([FIRST_WRITTEN_ID], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()
        })
        .expect("the copy's writes read");
    let covered = i64::try_from(copied_through).expect("a count");
    assert!(covered < WRITE_COUNT, "writes went on past the copy");
    assert_eq!(
        held,
        (FIRST_WRITTEN_ID + 1..=FIRST_WRITTEN_ID + covered).collect::<Vec<_>>()
    );
    writer.close(None).await.expect("the writer closes");
}

// A step that meets a lock waits, without ending the copy, serving the requests that come; once
// another connection lets the lock go, the copy steps again within 250 ms with no request to wake
// it and finishes; with the lock kept, the copy ends at its bound naming it. Killed by a lock read
// as the copy's failure, by a held step stepped again only after a request, and by the bound
// dropped, which leaves the copy waiting.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_copy_meeting_a_lock_steps_again_once_it_clears_and_ends_at_its_bound() {
    let database = filled_database();
    let destination = database.path().with_file_name("copy.db");
    let blocker = lock_destination(&destination);
    let (sender, requests) = mpsc::channel(4);
    let answered = start_copy(
        database.path(),
        destination.clone(),
        CancellationToken::new(),
        LOCK_BOUND,
        requests,
    );
    let (checkpoint, checkpoint_answer) = checkpoint_request();
    sender.try_send(checkpoint).expect("the request is queued");
    assert!(checkpoint_answer.await.expect("served").is_ok());
    assert!(
        answered.recv_timeout(HELD_SPAN).is_err(),
        "a copy meeting a lock waits"
    );
    blocker
        .execute_batch("ROLLBACK")
        .expect("the destination is let go");
    drop(blocker);
    let (answer, _) = answered.recv_timeout(WAIT).expect("the copy answers");
    assert!(matches!(
        answer.expect("the copy succeeds").report,
        BackupCopy::Copied { .. }
    ));

    let held_destination = database.path().with_file_name("held.db");
    let _blocker = lock_destination(&held_destination);
    let (_sender, requests) = mpsc::channel(4);
    let (answer, _) = start_copy(
        database.path(),
        held_destination,
        CancellationToken::new(),
        Duration::from_millis(200),
        requests,
    )
    .recv_timeout(WAIT)
    .expect("the copy ends at its bound");
    assert!(matches!(
        answer.expect("the copy answers how it ended").report,
        BackupCopy::HeldByLock(BackupLock::Busy)
    ));
}

// A copy canceled while it waits out a lock stops at once, before another step, with no request
// to wake it. Killed by the cancel not checked, which leaves the copy waiting for its bound.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_canceled_copy_stops_before_its_next_step() {
    let database = filled_database();
    let destination = database.path().with_file_name("copy.db");
    let _blocker = lock_destination(&destination);
    let (_sender, requests) = mpsc::channel(4);
    let cancel = CancellationToken::new();
    let answered = start_copy(
        database.path(),
        destination,
        cancel.clone(),
        LOCK_BOUND,
        requests,
    );
    assert!(answered.recv_timeout(HELD_SPAN).is_err());
    cancel.cancel();
    let (answer, is_queue_gone) = answered.recv_timeout(WAIT).expect("the copy answers");
    assert!(matches!(
        answer.expect("the copy answers how it ended").report,
        BackupCopy::Stopped
    ));
    assert!(!is_queue_gone);
}
