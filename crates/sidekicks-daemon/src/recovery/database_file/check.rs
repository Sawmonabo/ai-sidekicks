//! The start's structural check of the database file: `PRAGMA quick_check` on a read-only
//! connection of its own, on a blocking thread, so the check holds no thread that serves a write or
//! a search. A stop ends it within one page: SQLite's walk of the file calls the connection's
//! progress handler as it reads each b-tree page, and the handler answers the stop, which an
//! interrupt sent before the walk began would not. The connection waits out a writer's lock, and
//! answers as the file stood when the check began.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, ErrorCode};
use tokio::task::{JoinError, JoinHandle};
use tokio_util::sync::{CancellationToken, DropGuard};

use crate::cleanup_failures::CleanupFailures;
use crate::database::connection::setup::open_database_reader;
use crate::recovery::database_file::READ_BUSY_TIMEOUT;

// The check runs one statement, uncached.
const CHECK_STATEMENT_CAPACITY: usize = 0;

/// What `quick_check` and `integrity_check` answer for a sound file, as their one row.
pub(crate) const SOUND_ROW: &str = "ok";

/// What the check found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DatabaseFileCheckAnswer {
    /// The file is sound.
    Sound,
    /// The file is damaged, as SQLite reported it.
    Damaged(String),
    /// A stop ended the check first.
    Stopped,
}

/// Why the check could not run.
#[derive(Debug, thiserror::Error)]
pub enum DatabaseFileCheckError {
    /// The file did not open for reading, for a reason other than damage.
    #[error("the database file did not open for its check")]
    Open(#[source] CleanupFailures<rusqlite::Error>),
    /// The check failed for a reason other than damage, a busy file among them.
    #[error("the database file's check could not run")]
    Run(#[source] rusqlite::Error),
    /// The check answered no row.
    #[error("the database file's check answered nothing")]
    NoAnswer,
    /// The check's thread ended before it answered.
    #[error("the database file's check ended before it answered")]
    Interrupted(#[source] JoinError),
    /// The check answered, but its connection did not close.
    #[error("the database file's connection did not close after its check")]
    Close(#[source] rusqlite::Error),
    /// The check failed, and its connection did not close after it either.
    #[error(transparent)]
    Unclosed(Box<CleanupFailures<DatabaseFileCheckError, rusqlite::Error>>),
}

/// One run of the check on the daemon's database file. Start it with [`DatabaseFileCheck::start`];
/// dropping it stops the check.
pub struct DatabaseFileCheck {
    stop: CancellationToken,
    // Stops the check when this is dropped, so a dropped check stops walking the file.
    _stop_on_drop: DropGuard,
    task: JoinHandle<Result<DatabaseFileCheckAnswer, DatabaseFileCheckError>>,
}

impl DatabaseFileCheck {
    /// Starts the check of the file at `database_path`, which exists, on a blocking thread;
    /// returns at once.
    pub fn start(database_path: PathBuf) -> Self {
        let stop = CancellationToken::new();
        let task = tokio::task::spawn_blocking({
            let stop = stop.clone();
            move || check_database_file(&database_path, &stop)
        });
        Self {
            _stop_on_drop: stop.clone().drop_guard(),
            stop,
            task,
        }
    }

    /// Ends the check if it still runs; its answer is then [`DatabaseFileCheckAnswer::Stopped`].
    pub(crate) fn stop(&self) {
        self.stop.cancel();
    }

    /// What the check found, awaited until it answers once. Fails when the check could not run.
    pub async fn answer(&mut self) -> Result<DatabaseFileCheckAnswer, DatabaseFileCheckError> {
        (&mut self.task)
            .await
            .map_err(DatabaseFileCheckError::Interrupted)?
    }
}

// Opens the file read-only and checks it; a file too damaged to open is damaged.
fn check_database_file(
    database_path: &Path,
    stop: &CancellationToken,
) -> Result<DatabaseFileCheckAnswer, DatabaseFileCheckError> {
    let connection = match open_database_reader(database_path, CHECK_STATEMENT_CAPACITY) {
        Ok(connection) => connection,
        Err(failure) if is_damage(failure.original()) => {
            return Ok(DatabaseFileCheckAnswer::Damaged(
                failure.original().to_string(),
            ));
        }
        Err(failure) => return Err(DatabaseFileCheckError::Open(failure)),
    };
    let checked = connection
        .busy_timeout(READ_BUSY_TIMEOUT)
        .map_err(DatabaseFileCheckError::Run)
        .and_then(|()| run_quick_check(&connection, stop));
    let closed = connection
        .close()
        .map_err(|(_, close_failure)| close_failure);
    match (checked, closed) {
        (checked, Ok(())) => checked,
        (Ok(_), Err(close_failure)) => Err(DatabaseFileCheckError::Close(close_failure)),
        (Err(check_failure), Err(close_failure)) => Err(DatabaseFileCheckError::Unclosed(
            Box::new(CleanupFailures::new(
                check_failure,
                vec![close_failure],
                "the database file's check",
            )),
        )),
    }
}

// Runs `quick_check` on `connection`, interrupted once `stop` fires.
fn run_quick_check(
    connection: &Connection,
    stop: &CancellationToken,
) -> Result<DatabaseFileCheckAnswer, DatabaseFileCheckError> {
    let handler_stop = stop.clone();
    connection
        .progress_handler(1, Some(move || handler_stop.is_cancelled()))
        .map_err(DatabaseFileCheckError::Run)?;
    let rows = read_check_rows(connection);
    read_check_verdict(rows, stop.is_cancelled())
}

// Every row `quick_check` answers.
fn read_check_rows(connection: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut statement = connection.prepare("PRAGMA quick_check")?;
    statement.query_map([], |row| row.get(0))?.collect()
}

// The check's verdict from its rows, or its failure: one `ok` row is sound, any other rows are the
// damage the walk stepped past, and a failure SQLite raises for a damaged or foreign file is
// damage. An interrupt after the stop is the stop; any other failure, a busy one among them, means
// the check could not run.
fn read_check_verdict(
    rows: rusqlite::Result<Vec<String>>,
    is_stopped: bool,
) -> Result<DatabaseFileCheckAnswer, DatabaseFileCheckError> {
    match rows {
        Ok(rows) => match rows.as_slice() {
            [] => Err(DatabaseFileCheckError::NoAnswer),
            [only] if only == SOUND_ROW => Ok(DatabaseFileCheckAnswer::Sound),
            damage => Ok(DatabaseFileCheckAnswer::Damaged(damage.join("\n"))),
        },
        Err(failure) if is_damage(&failure) => {
            Ok(DatabaseFileCheckAnswer::Damaged(failure.to_string()))
        }
        Err(failure)
            if is_stopped
                && failure.sqlite_error_code() == Some(ErrorCode::OperationInterrupted) =>
        {
            Ok(DatabaseFileCheckAnswer::Stopped)
        }
        Err(failure) => Err(DatabaseFileCheckError::Run(failure)),
    }
}

// Whether SQLite failed because the file is damaged (`SQLITE_CORRUPT`) or no database
// (`SQLITE_NOTADB`).
fn is_damage(failure: &rusqlite::Error) -> bool {
    matches!(
        failure.sqlite_error_code(),
        Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase)
    )
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    use rusqlite::{Connection, ffi};
    use tokio_util::sync::CancellationToken;

    use super::{
        CHECK_STATEMENT_CAPACITY, DatabaseFileCheckAnswer, DatabaseFileCheckError,
        read_check_verdict, run_quick_check,
    };
    use crate::database::connection::setup::open_database_reader;

    fn sqlite_failure(code: i32) -> rusqlite::Error {
        rusqlite::Error::SqliteFailure(ffi::Error::new(code), None)
    }

    fn rows(rows: &[&str]) -> Vec<String> {
        rows.iter().map(|row| (*row).to_owned()).collect()
    }

    // What a verdict is, without the damage's words.
    fn verdict_kind(
        verdict: &Result<DatabaseFileCheckAnswer, DatabaseFileCheckError>,
    ) -> &'static str {
        match verdict {
            Ok(DatabaseFileCheckAnswer::Sound) => "sound",
            Ok(DatabaseFileCheckAnswer::Damaged(_)) => "damaged",
            Ok(DatabaseFileCheckAnswer::Stopped) => "stopped",
            Err(DatabaseFileCheckError::Run(_)) => "could not run",
            Err(_) => "another failure",
        }
    }

    #[rstest]
    #[case::sound(Ok(rows(&["ok"])), false, "sound")]
    #[case::damage_the_walk_stepped_past(
        Ok(rows(&["*** in database main ***", "Page 5: never used"])),
        false,
        "damaged"
    )]
    #[case::a_lone_row_that_is_not_ok(Ok(rows(&["Page 5: never used"])), false, "damaged")]
    #[case::a_malformed_file(Err(sqlite_failure(ffi::SQLITE_CORRUPT)), false, "damaged")]
    #[case::no_database(Err(sqlite_failure(ffi::SQLITE_NOTADB)), false, "damaged")]
    #[case::stopped(Err(sqlite_failure(ffi::SQLITE_INTERRUPT)), true, "stopped")]
    #[case::busy(Err(sqlite_failure(ffi::SQLITE_BUSY)), false, "could not run")]
    #[case::interrupted_with_no_stop(
        Err(sqlite_failure(ffi::SQLITE_INTERRUPT)),
        false,
        "could not run"
    )]
    fn reads_each_verdict(
        #[case] outcome: rusqlite::Result<Vec<String>>,
        #[case] is_stopped: bool,
        #[case] expected: &str,
    ) {
        let verdict = read_check_verdict(outcome, is_stopped);

        assert_eq!(verdict_kind(&verdict), expected, "{verdict:?}");
    }

    #[test]
    fn a_stop_once_the_walk_has_begun_ends_it_with_no_damage() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let database_path = scratch.path().join("daemon.db");
        let writer = Connection::open(&database_path).expect("the file opens");
        // Pages enough for the walk to begin; the check reads pages, never the schema.
        writer
            .execute_batch(
                "CREATE TABLE filler (n INTEGER PRIMARY KEY, text TEXT);
                 WITH RECURSIVE counter(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM counter
                   WHERE n < 4000)
                 INSERT INTO filler SELECT n, printf('%.200c', 'x') FROM counter;",
            )
            .expect("the rows are written");
        drop(writer);
        let connection = open_database_reader(&database_path, CHECK_STATEMENT_CAPACITY)
            .expect("the file opens for reading");
        let stop = CancellationToken::new();
        let stopping = stop.clone();
        // The stop fires as the check's statement is prepared, after any look at the stop before
        // it.
        connection
            .authorizer(Some(move |context: AuthContext<'_>| {
                if let AuthAction::Pragma { pragma_name, .. } = context.action
                    && pragma_name == "quick_check"
                {
                    stopping.cancel();
                }
                Authorization::Allow
            }))
            .expect("the authorizer is set");

        let answer = run_quick_check(&connection, &stop).expect("the check answers");

        assert_eq!(answer, DatabaseFileCheckAnswer::Stopped);
    }
}
