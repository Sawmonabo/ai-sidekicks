//! The online copy of the database on the writer's thread: SQLite's backup steps a bounded count
//! of pages at a time from the writer's own connection, and between steps the thread serves the
//! request waiting, so writes go on while the copy lives and SQLite carries each one into the copy;
//! a write through any other connection would restart it, and the writer's is the only one. A
//! step that meets a lock is stepped again after the next request or a short wait, and a copy
//! whose steps have met a lock for ten minutes running ends naming it. The copy's file opens in
//! SQLite's default rollback mode, since a WAL copy whose page size differs is refused.

use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

use rusqlite::Connection;
use rusqlite::backup::{Backup, StepResult};
use tokio::sync::mpsc::{self, error::TryRecvError};

use crate::cleanup_failures::CleanupFailures;
use crate::database::writer::ThreadStop;
use crate::database::writer::messages::ThreadRequest;
use crate::database::writer::thread::serve_request;
use crate::events::content::codec::BodyEncoder;

/// The pages one step copies, rusqlite's own step size.
const PAGES_PER_STEP: i32 = 100;

/// How long the steps may meet a lock before the copy ends.
const LOCK_BOUND: Duration = Duration::from_mins(10);

/// The wait before a step that met a lock is tried again, when no request waits.
const LOCK_RETRY_WAIT: Duration = Duration::from_millis(50);

const BACKUP_OPERATION: &str = "copying the database";

/// The lock a step met.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BackupLock {
    /// Another connection held a lock the step needed (`SQLITE_BUSY`).
    Busy,
    /// The source connection was writing to the database (`SQLITE_LOCKED`).
    Locked,
}

impl BackupLock {
    /// The lock in the service's own words, for the run's failure.
    pub(crate) fn describe(self) -> &'static str {
        match self {
            Self::Busy => "another connection held the database's lock for ten minutes",
            Self::Locked => "the database's own writes held its table lock for ten minutes",
        }
    }
}

/// How one copy ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BackupCopy {
    /// Every page was copied: the database's page count when the copy finished.
    Copied {
        /// The pages copied.
        page_count: i64,
    },
    /// The steps met `lock` for ten minutes running; the copy is incomplete.
    HeldByLock(BackupLock),
    /// The queue let the thread go before the copy finished.
    Stopped,
}

/// The thread's answer to one copy: how it ended, or SQLite's failure.
pub(crate) type BackupAnswer = Result<BackupCopy, CleanupFailures<rusqlite::Error>>;

/// Copies the writer's database into the file at `destination`, serving each request that waits
/// between steps. Answers how the copy ended and whether the queue is gone, so the thread stops
/// serving. Fails with SQLite's error when the copy's file cannot open or a step fails.
pub(super) fn copy_database(
    connection: &Connection,
    encoder: &mut BodyEncoder,
    destination: &Path,
    requests: &mut mpsc::Receiver<ThreadRequest>,
    stop: &ThreadStop,
) -> (BackupAnswer, bool) {
    let alone =
        |failure: rusqlite::Error| CleanupFailures::new(failure, Vec::new(), BACKUP_OPERATION);
    let mut copy = match Connection::open(destination) {
        Ok(copy) => copy,
        Err(failure) => return (Err(alone(failure)), false),
    };
    let stepped = step_until_done(connection, &mut copy, encoder, requests, stop);
    let closed = copy.close().map_err(|(_copy, failure)| failure);
    match (stepped, closed) {
        ((Ok(copy_end), is_queue_gone), Ok(())) => (Ok(copy_end), is_queue_gone),
        ((Ok(_copy_end), is_queue_gone), Err(close_failure)) => {
            (Err(alone(close_failure)), is_queue_gone)
        }
        ((Err(failure), is_queue_gone), Ok(())) => (Err(alone(failure)), is_queue_gone),
        ((Err(failure), is_queue_gone), Err(close_failure)) => (
            Err(CleanupFailures::new(
                failure,
                vec![close_failure],
                BACKUP_OPERATION,
            )),
            is_queue_gone,
        ),
    }
}

// Steps the copy until it is done, serving one waiting request after each step.
fn step_until_done(
    connection: &Connection,
    copy: &mut Connection,
    encoder: &mut BodyEncoder,
    requests: &mut mpsc::Receiver<ThreadRequest>,
    stop: &ThreadStop,
) -> (rusqlite::Result<BackupCopy>, bool) {
    let backup = match Backup::new(connection, copy) {
        Ok(backup) => backup,
        Err(failure) => return (Err(failure), false),
    };
    let mut held_since: Option<Instant> = None;
    loop {
        if stop.is_stopped() {
            return (Ok(BackupCopy::Stopped), false);
        }
        let held = match backup.step(PAGES_PER_STEP) {
            Ok(StepResult::Done) => {
                let page_count = i64::from(backup.progress().pagecount);
                return (Ok(BackupCopy::Copied { page_count }), false);
            }
            Ok(StepResult::Busy) => Some(BackupLock::Busy),
            Ok(StepResult::Locked) => Some(BackupLock::Locked),
            Ok(_more) => None,
            Err(failure) => return (Err(failure), false),
        };
        #[cfg(test)]
        tests::record_pages_done(&backup);
        match held {
            Some(lock) => {
                let since = *held_since.get_or_insert_with(Instant::now);
                if since.elapsed() >= LOCK_BOUND {
                    return (Ok(BackupCopy::HeldByLock(lock)), false);
                }
            }
            None => held_since = None,
        }
        match requests.try_recv() {
            Ok(request) => {
                if !serve_request(connection, encoder, request, requests, stop) {
                    return (Ok(BackupCopy::Stopped), true);
                }
            }
            Err(TryRecvError::Empty) => {
                if held.is_some() {
                    thread::sleep(LOCK_RETRY_WAIT);
                }
            }
            Err(TryRecvError::Disconnected) => return (Ok(BackupCopy::Stopped), true),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use rusqlite::backup::Backup;
    use tokio::sync::{mpsc, oneshot};

    use super::{BackupCopy, copy_database};
    use crate::database::checkpoint::CheckpointMode;
    use crate::database::connection::writer_open::open_database;
    use crate::database::statement::{StatementBindings, WriteStatement};
    use crate::database::writer::ThreadStop;
    use crate::database::writer::messages::{ThreadRequest, WriteJob};
    use crate::database::writer::test_file::TestDatabase;
    use crate::events::content::codec::BodyEncoder;

    thread_local! {
        // The pages each step of a copy on this thread had copied, in order.
        static PAGES_DONE: RefCell<Vec<i32>> = const { RefCell::new(Vec::new()) };
    }

    /// Records the pages `backup` has copied after a step.
    pub(super) fn record_pages_done(backup: &Backup<'_, '_>) {
        let progress = backup.progress();
        PAGES_DONE.with_borrow_mut(|done| done.push(progress.pagecount - progress.remaining));
    }

    fn write_statement(sql: &str) -> WriteStatement {
        WriteStatement {
            sql: sql.to_owned().into(),
            bindings: StatementBindings::Positional(Vec::new()),
            expected_row_count: None,
        }
    }

    // A write and a checkpoint queued while the copy steps are served between its steps: the write
    // lands in the copy, which passes SQLite's whole check, and no step copies fewer pages than the
    // one before, so neither restarted the copy. Killed by `run_to_completion` and by a write
    // through a second connection, which restarts the copy.
    #[test]
    fn a_write_made_during_the_copy_lands_in_it_without_restarting_it() {
        let database = TestDatabase::new();
        let connection = open_database(&database.path()).expect("the writer's connection opens");
        connection
            .execute_batch(
                "CREATE TABLE filler (id INTEGER PRIMARY KEY, body BLOB);
                 WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600)
                 INSERT INTO filler SELECT i, zeroblob(4000) FROM n;",
            )
            .expect("the filler is written");
        let (sender, mut requests) = mpsc::channel(4);
        let (batch_reply, batch_answer) = oneshot::channel();
        let (checkpoint_reply, checkpoint_answer) = oneshot::channel();
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
        sender
            .try_send(ThreadRequest::Checkpoint {
                mode: CheckpointMode::Passive,
                reply: checkpoint_reply,
            })
            .expect("the checkpoint is queued");
        let destination = database.path().with_file_name("copy.db");

        let (answer, is_queue_gone) = copy_database(
            &connection,
            &mut BodyEncoder::new(),
            &destination,
            &mut requests,
            &ThreadStop::new(),
        );

        assert!(matches!(answer, Ok(BackupCopy::Copied { .. })));
        assert!(!is_queue_gone);
        assert!(batch_answer.blocking_recv().expect("answered").is_ok());
        assert!(checkpoint_answer.blocking_recv().expect("answered").is_ok());
        let pages_done = PAGES_DONE.with_borrow(Clone::clone);
        assert!(pages_done.len() > 2, "the copy took several steps");
        assert!(pages_done.is_sorted(), "no step went back: {pages_done:?}");
        let copy = rusqlite::Connection::open(&destination).expect("the copy opens");
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
}
