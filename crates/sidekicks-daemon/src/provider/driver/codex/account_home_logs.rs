//! Codex's log rows in an account home: its service writes its diagnostic log as rows of the
//! home's `logs_2.sqlite`, each stamped with the second it was written, and the expiry deletes the
//! rows past `Keep diagnostic logs for` by the condition Codex's own prune uses, a bounded batch at
//! a time. Codex's own prune frees its rows' pages as they were, so while no service holds the
//! home the database is also rebuilt without its free space, where room for the copy allows.

use std::error::Error;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags, params};

use rusqlite::ErrorCode;
use sidekicks_platforms::volume_free_bytes;

use crate::missing_entry::MissingEntry as _;

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

/// Deletes from the log database in the Codex home `home` every row written in a second before
/// `cutoff`'s, a bounded batch per statement, through a connection of its own that overwrites the
/// freed pages, and answers the rows it deleted; nothing when the database is absent. Blocking.
/// Fails when the database cannot be opened or a batch deleted, leaving the batches before it
/// deleted.
pub(super) fn expire_account_home_logs(
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

/// Rebuilds the log database in the Codex home `home` without its free space, so no row Codex's
/// own prune or an earlier expiry freed keeps its text there or in the database's log, then empties
/// the log; called only on a home no service holds. Skipped, nothing changed, when the database
/// is absent, when a writer holds it, and when its volume has less free room than twice the
/// database and its log, which the rebuild's copy may take. Blocking. Fails when the database
/// cannot be opened or rebuilt.
pub(super) fn compact_quiet_account_home_logs(
    home: &Path,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let database = home.join(LOGS_DATABASE_FILE_NAME);
    let Some(metadata) = std::fs::symlink_metadata(&database).none_if_missing()? else {
        return Ok(());
    };
    let log_bytes = std::fs::symlink_metadata(database.with_extension("sqlite-wal"))
        .none_if_missing()?
        .map_or(0, |log| log.len());
    let needed = metadata.len().saturating_add(log_bytes).saturating_mul(2);
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
            Ok(())
        }
        compacted => Ok(compacted?),
    }
}

#[cfg(test)]
mod tests {
    use std::io::ErrorKind;
    use std::time::{Duration, UNIX_EPOCH};

    use rusqlite::{Connection, params};

    use super::{
        LOGS_DATABASE_FILE_NAME, ROWS_PER_DELETE, compact_quiet_account_home_logs,
        expire_account_home_logs,
    };

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
    // rebuild leaves it in neither the database nor its log; an absent database is left absent.
    // Killed by the rebuild dropped, and by the log left holding the pages it copied.
    #[test]
    fn a_quiet_home_s_rebuild_leaves_no_text_codex_s_own_prune_freed() {
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

        compact_quiet_account_home_logs(home.path()).expect("the database is rebuilt");

        assert!(
            !holds_marker(&database),
            "the rebuild left a deleted row's text"
        );
        let kept: i64 = Connection::open(&database)
            .and_then(|connection| {
                connection.query_row("SELECT COUNT(*) FROM logs", [], |row| row.get(0))
            })
            .expect("the kept rows read");
        assert_eq!(kept, 1);

        let empty_home = tempfile::tempdir().expect("the home is made");
        compact_quiet_account_home_logs(empty_home.path()).expect("an absent database is no fault");
        assert!(!empty_home.path().join(LOGS_DATABASE_FILE_NAME).exists());
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
