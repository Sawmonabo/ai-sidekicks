//! Codex's log rows in an account home: its service writes its diagnostic log as rows of the
//! home's `logs_2.sqlite`, each stamped with the second it was written, and the expiry deletes the
//! rows past `Keep diagnostic logs for` by the condition Codex's own prune uses, a bounded batch at
//! a time. Codex's own prune frees its rows' pages as they were, so while no service holds the
//! home the database is also rebuilt without its free space, where room for the copy allows and
//! once something wrote to it since its last rebuild.

use std::collections::HashMap;
use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags, params};

use rusqlite::ErrorCode;
use sidekicks_platforms::volume_free_bytes;

use crate::missing_entry::MissingEntry as _;
use crate::mutex_lock::lock;

// Codex's log database in its home.
const LOGS_DATABASE_FILE_NAME: &str = "logs_2.sqlite";

// How long a delete waits for Codex's own writer, as long as Codex's own connections wait.
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

// The most rows one delete removes: each delete holds Codex's write lock only while it frees and
// overwrites this many rows' pages, well inside the 5 s a Codex connection waits for it.
const ROWS_PER_DELETE: usize = 1_000;

// Up to `?2` rows written before the second `?1`; a row's `ts` is the Unix second it was written.
const DELETE_OLDER_ROWS_SQL: &str =
    "DELETE FROM logs WHERE rowid IN (SELECT rowid FROM logs WHERE ts < ?1 LIMIT ?2)";

// Deletes from the log database in the Codex home `home` every row written in a second before
// `cutoff`'s, a bounded batch per statement, through a connection of its own that overwrites the
// freed pages, and answers the rows it deleted; nothing when the database is absent. Blocking.
// Fails when the database cannot be opened or a batch deleted, leaving the batches before it
// deleted.
fn expire_account_home_logs(
    home: &Path,
    cutoff: SystemTime,
) -> Result<u64, Box<dyn Error + Send + Sync>> {
    let database = home.join(LOGS_DATABASE_FILE_NAME);
    if std::fs::symlink_metadata(&database)
        .none_if_missing()?
        .is_none()
    {
        return Ok(0);
    }
    // A cutoff before 1970 is older than any row.
    let Ok(cutoff_second) = cutoff.duration_since(UNIX_EPOCH) else {
        return Ok(0);
    };
    let cutoff_second = i64::try_from(cutoff_second.as_secs())?;
    let connection = Connection::open_with_flags(
        &database,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.busy_timeout(BUSY_TIMEOUT)?;
    connection.pragma_update(None, "secure_delete", "ON")?;
    let mut delete = connection.prepare(DELETE_OLDER_ROWS_SQL)?;
    let batch_limit = i64::try_from(ROWS_PER_DELETE)?;
    let mut deleted = 0;
    loop {
        let batch = delete.execute(params![cutoff_second, batch_limit])?;
        deleted += u64::try_from(batch)?;
        if batch < ROWS_PER_DELETE {
            return Ok(deleted);
        }
    }
}

/// The expiry of Codex's log rows in its account homes, remembering how each quiet home's log
/// database looked once its last rebuild ended, so one nothing wrote to since is not rebuilt again.
#[derive(Default)]
pub(crate) struct AccountHomeLogExpiry {
    rebuilt: Mutex<HashMap<PathBuf, LogDatabaseStamp>>,
}

impl AccountHomeLogExpiry {
    /// Deletes from the log database in the Codex home `home` every row written in a second before
    /// `cutoff`'s, then, when `is_home_quiet` says no service holds the home, rebuilds the database
    /// without its free space, so no row Codex's own prune or an earlier expiry freed keeps its
    /// text there or in the database's log; answers the rows deleted. A failed rebuild is logged
    /// with its error, the rows deleted answered still. Blocking. Fails as the delete fails.
    pub(crate) fn expire(
        &self,
        home: &Path,
        cutoff: SystemTime,
        is_home_quiet: impl FnOnce() -> bool,
    ) -> Result<u64, Box<dyn Error + Send + Sync>> {
        let deleted = expire_account_home_logs(home, cutoff)?;
        if is_home_quiet()
            && let Err(error) = self.rebuild_if_changed(home)
        {
            tracing::warn!(
                codex_home = %home.display(),
                error = &*error as &(dyn Error + 'static),
                "a codex home's log database could not be rebuilt"
            );
        }
        Ok(deleted)
    }

    // Rebuilds the log database in the Codex home `home` and empties its log, unless the database
    // and its log are as its last rebuild here left them. Skipped, nothing changed, when the
    // database is absent, when a writer holds it, and when its volume has less free room than
    // twice the database and its log, which the rebuild's copy may take. Fails when the database
    // cannot be read, opened or rebuilt.
    fn rebuild_if_changed(&self, home: &Path) -> Result<(), Box<dyn Error + Send + Sync>> {
        let database = home.join(LOGS_DATABASE_FILE_NAME);
        let Some(stamp) = read_log_database_stamp(&database)? else {
            self.lock_rebuilt().remove(home);
            return Ok(());
        };
        if self.lock_rebuilt().get(home) == Some(&stamp) {
            return Ok(());
        }
        let needed = stamp
            .length
            .saturating_add(stamp.log_length)
            .saturating_mul(2);
        if volume_free_bytes(home)? < needed {
            tracing::info!(
                codex_home = %home.display(),
                needed,
                "a codex home's log database was not rebuilt, its volume short of room for the copy"
            );
            return Ok(());
        }
        let connection = Connection::open_with_flags(
            &database,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        // A writer that came back after the quiet check is never waited on.
        connection.busy_timeout(Duration::ZERO)?;
        match connection.execute_batch("VACUUM; PRAGMA wal_checkpoint(TRUNCATE);") {
            Err(rusqlite::Error::SqliteFailure(failure, _))
                if matches!(
                    failure.code,
                    ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked
                ) =>
            {
                return Ok(());
            }
            compacted => compacted?,
        }
        // The last connection's close removes the emptied log, so the database is read after it.
        connection.close().map_err(|(_, error)| error)?;
        if let Some(rebuilt) = read_log_database_stamp(&database)? {
            self.lock_rebuilt().insert(home.to_owned(), rebuilt);
        }
        Ok(())
    }

    fn lock_rebuilt(&self) -> MutexGuard<'_, HashMap<PathBuf, LogDatabaseStamp>> {
        lock(&self.rebuilt)
    }
}

// A log database's length and last write, with its log's length, none when it has no log: a
// write by any connection changes one of them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct LogDatabaseStamp {
    length: u64,
    modified: SystemTime,
    log_length: u64,
}

// The stamp of the log database `database`; none when it is absent.
fn read_log_database_stamp(database: &Path) -> io::Result<Option<LogDatabaseStamp>> {
    let Some(metadata) = std::fs::symlink_metadata(database).none_if_missing()? else {
        return Ok(None);
    };
    let log_length = std::fs::symlink_metadata(database.with_extension("sqlite-wal"))
        .none_if_missing()?
        .map_or(0, |log| log.len());
    Ok(Some(LogDatabaseStamp {
        length: metadata.len(),
        modified: metadata.modified()?,
        log_length,
    }))
}

#[cfg(test)]
mod tests {
    use std::io::ErrorKind;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use rusqlite::{Connection, params};

    use super::{
        AccountHomeLogExpiry, LOGS_DATABASE_FILE_NAME, ROWS_PER_DELETE, expire_account_home_logs,
    };
    use crate::provider::driver::diagnostics::RecordedEvents;

    // Codex's `logs` table as its log database holds it.
    const LOGS_TABLE_SQL: &str = "CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, \
         ts INTEGER NOT NULL, ts_nanos INTEGER NOT NULL, level TEXT NOT NULL, \
         target TEXT NOT NULL, feedback_log_body TEXT, module_path TEXT, file TEXT, line INTEGER, \
         thread_id TEXT, process_uuid TEXT, estimated_bytes INTEGER NOT NULL DEFAULT 0)";

    const CUTOFF_SECOND: i64 = 1_800_000_000;

    // The text of every row the expiry deletes.
    const DELETED_MARKER: &str = "deleted-log-text-5e0b";

    // Rows written a second before the cutoff's second go, more than one batch of them, each
    // counted, and the rest stay, a row in the cutoff's own second among them, as Codex's `<`
    // keeps it; once every connection has closed, neither the database nor its log holds a deleted
    // row's text; a home with no log database is no failure and is left without one. Killed by
    // `<=`, by the cutoff rounded up to its next second, by a cutoff in milliseconds, by one batch
    // alone or counted alone, by the freed pages left as they were, and by an absent database made
    // or refused.
    #[test]
    fn rows_before_the_cutoff_go_overwritten_and_an_absent_database_is_left_absent() {
        let home = tempfile::tempdir().expect("the home is made");
        let database = home.path().join(LOGS_DATABASE_FILE_NAME);
        let mut connection = Connection::open(&database).expect("the fixture opens");
        // The fixture's own writes overwrite what they free too, so no stale copy a page split
        // leaves holds the old rows' text, and only the rows the expiry deletes do.
        connection
            .execute_batch(&format!(
                "PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON; {LOGS_TABLE_SQL}"
            ))
            .expect("the table is made");
        let rows = connection
            .transaction()
            .expect("the fixture's write begins");
        for _ in 0..=2 * ROWS_PER_DELETE {
            rows.execute(
                "INSERT INTO logs (ts, ts_nanos, level, target, feedback_log_body) \
                 VALUES (?1, 0, 'INFO', 't', ?2)",
                params![CUTOFF_SECOND - 1, DELETED_MARKER],
            )
            .expect("an old row is written");
        }
        for ts in [CUTOFF_SECOND, CUTOFF_SECOND + 1] {
            rows.execute(
                "INSERT INTO logs (ts, ts_nanos, level, target) VALUES (?1, 0, 'INFO', 't')",
                [ts],
            )
            .expect("the row is written");
        }
        rows.commit().expect("the fixture's rows are written");
        // The old rows' text then sits in the database itself, not only in its log.
        connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .expect("the log is moved into the database");
        let cutoff = UNIX_EPOCH
            + Duration::from_secs(CUTOFF_SECOND.unsigned_abs())
            + Duration::from_millis(500);

        let deleted = expire_account_home_logs(home.path(), cutoff).expect("the rows are deleted");
        assert_eq!(
            deleted,
            u64::try_from(2 * ROWS_PER_DELETE + 1).expect("a count")
        );

        let kept: Vec<i64> = connection
            .prepare("SELECT ts FROM logs ORDER BY ts")
            .and_then(|mut statement| {
                statement
                    .query_map([], |row| row.get(0))?
                    .collect::<rusqlite::Result<_>>()
            })
            .expect("the rows read");
        assert_eq!(kept, vec![CUTOFF_SECOND, CUTOFF_SECOND + 1]);
        // The last connection to close moves the log into the database and deletes it, so the
        // bytes are read after it.
        connection.close().expect("the fixture closes");
        assert!(!holds_marker(&database), "a deleted row's text is left");

        let empty_home = tempfile::tempdir().expect("the home is made");
        let deleted = expire_account_home_logs(empty_home.path(), cutoff)
            .expect("an absent database is no fault");
        assert_eq!(deleted, 0);
        assert!(!empty_home.path().join(LOGS_DATABASE_FILE_NAME).exists());
    }

    // Rows Codex's own prune deleted leave their text in the freed pages, and the quiet home's
    // rebuild leaves it in neither the database nor its log; a second pass with nothing written
    // between rebuilds nothing; a home that is not quiet is not rebuilt; an absent database is left
    // absent. Killed by the rebuild dropped, by the log left holding the pages it copied, by the
    // change check dropped, and by the quiet check dropped.
    #[test]
    fn a_quiet_home_s_rebuild_leaves_no_text_codex_s_own_prune_freed_and_runs_once_per_write() {
        let home = tempfile::tempdir().expect("the home is made");
        let database = home.path().join(LOGS_DATABASE_FILE_NAME);
        let connection = Connection::open(&database).expect("the fixture opens");
        connection
            .execute_batch(&format!(
                "PRAGMA journal_mode = WAL; PRAGMA secure_delete = OFF; {LOGS_TABLE_SQL}"
            ))
            .expect("the table is made");
        for ts in [CUTOFF_SECOND - 1, CUTOFF_SECOND] {
            connection
                .execute(
                    "INSERT INTO logs (ts, ts_nanos, level, target, feedback_log_body) \
                     VALUES (?1, 0, 'INFO', 't', ?2)",
                    params![
                        ts,
                        if ts < CUTOFF_SECOND {
                            DELETED_MARKER
                        } else {
                            "kept"
                        }
                    ],
                )
                .expect("a row is written");
        }
        // Codex's own prune: its connection frees the pages as they were.
        connection
            .execute("DELETE FROM logs WHERE ts < ?1", [CUTOFF_SECOND])
            .expect("codex's prune deletes the old row");
        connection.close().expect("the fixture closes");
        assert!(
            holds_marker(&database),
            "the prune left the text in the freed space"
        );
        let expiry = AccountHomeLogExpiry::default();

        // A cutoff of 1970 deletes nothing, so only the rebuild can clear the text.
        let deleted = expiry
            .expire(home.path(), UNIX_EPOCH, || false)
            .expect("the pass runs");
        assert_eq!(deleted, 0);
        assert!(
            holds_marker(&database),
            "a home a service holds was rebuilt"
        );
        expiry
            .expire(home.path(), UNIX_EPOCH, || true)
            .expect("the database is rebuilt");
        assert!(
            !holds_marker(&database),
            "the rebuild left a deleted row's text"
        );
        let rebuilt_at = last_write(&database);
        expiry
            .expire(home.path(), UNIX_EPOCH, || true)
            .expect("the second pass runs");
        assert_eq!(
            last_write(&database),
            rebuilt_at,
            "a database nothing wrote to since its rebuild was rebuilt again"
        );
        let kept: i64 = Connection::open(&database)
            .and_then(|connection| {
                connection.query_row("SELECT COUNT(*) FROM logs", [], |row| row.get(0))
            })
            .expect("the kept rows read");
        assert_eq!(kept, 1);

        let empty_home = tempfile::tempdir().expect("the home is made");
        expiry
            .expire(empty_home.path(), UNIX_EPOCH, || true)
            .expect("an absent database is no fault");
        assert!(!empty_home.path().join(LOGS_DATABASE_FILE_NAME).exists());
    }

    // A rebuild that fails, here on a database that turned to no database once its rows were
    // deleted, is logged and the rows deleted are answered still. Killed by the rebuild's failure
    // answered in place of the count, and by the failure not logged.
    #[test]
    fn a_failed_rebuild_is_logged_and_the_rows_deleted_are_answered() {
        let home = tempfile::tempdir().expect("the home is made");
        let database = home.path().join(LOGS_DATABASE_FILE_NAME);
        let connection = Connection::open(&database).expect("the fixture opens");
        connection
            .execute_batch(LOGS_TABLE_SQL)
            .expect("the table is made");
        connection
            .execute(
                "INSERT INTO logs (ts, ts_nanos, level, target) VALUES (?1, 0, 'INFO', 't')",
                [CUTOFF_SECOND - 1],
            )
            .expect("the row is written");
        connection.close().expect("the fixture closes");
        let cutoff = UNIX_EPOCH + Duration::from_secs(CUTOFF_SECOND.unsigned_abs());
        let recorded = RecordedEvents::default();

        let mut expired = None;
        recorded.record_during(|| {
            expired = Some(
                AccountHomeLogExpiry::default().expire(home.path(), cutoff, || {
                    std::fs::write(&database, b"no database").expect("the database is overwritten");
                    true
                }),
            );
        });

        let deleted = expired
            .expect("the pass ran")
            .expect("a failed rebuild fails no expiry");
        assert_eq!(deleted, 1);
        assert_eq!(
            recorded.messages(),
            vec!["a codex home's log database could not be rebuilt".to_owned()]
        );
    }

    // When the database file was last written.
    fn last_write(database: &std::path::Path) -> SystemTime {
        std::fs::metadata(database)
            .and_then(|metadata| metadata.modified())
            .expect("the database's last write reads")
    }

    // Whether the database or its log holds a deleted row's text.
    fn holds_marker(database: &std::path::Path) -> bool {
        [database.to_owned(), database.with_extension("sqlite-wal")]
            .iter()
            .any(|file| {
                let bytes = match std::fs::read(file) {
                    Ok(bytes) => bytes,
                    Err(error) if error.kind() == ErrorKind::NotFound => return false,
                    Err(error) => panic!("{} does not read: {error}", file.display()),
                };
                bytes
                    .windows(DELETED_MARKER.len())
                    .any(|window| window == DELETED_MARKER.as_bytes())
            })
    }
}
