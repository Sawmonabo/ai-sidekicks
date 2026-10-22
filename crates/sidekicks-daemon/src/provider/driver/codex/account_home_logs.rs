//! Codex's log rows in an account home: its service writes its diagnostic log as rows of the
//! home's `logs_2.sqlite`, each stamped with the second it was written, and the expiry deletes the
//! rows past `Keep diagnostic logs for` with the statement Codex's own prune runs.

use std::error::Error;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags};

use crate::missing_entry::MissingEntry as _;

// Codex's log database in its home.
const LOGS_DATABASE_FILE_NAME: &str = "logs_2.sqlite";

// How long a delete waits for Codex's own writer, as long as Codex's own connections wait.
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

// Each row's `ts` is the Unix second it was written.
const DELETE_OLDER_ROWS_SQL: &str = "DELETE FROM logs WHERE ts < ?1";

/// Deletes from the log database in the Codex home `home` every row written in a second before
/// `cutoff`'s, through a connection of its own that overwrites the freed pages; nothing when the
/// database is absent. Blocking. Fails when the database cannot be opened or the rows deleted.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Codex driver's expiry of its account home calls it"
    )
)]
pub(super) fn expire_account_home_logs(
    home: &Path,
    cutoff: SystemTime,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let database = home.join(LOGS_DATABASE_FILE_NAME);
    if std::fs::symlink_metadata(&database)
        .none_if_missing()?
        .is_none()
    {
        return Ok(());
    }
    // A cutoff before 1970 is older than any row.
    let Ok(cutoff_second) = cutoff.duration_since(UNIX_EPOCH) else {
        return Ok(());
    };
    let cutoff_second = i64::try_from(cutoff_second.as_secs())?;
    let connection = Connection::open_with_flags(
        &database,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.busy_timeout(BUSY_TIMEOUT)?;
    connection.pragma_update(None, "secure_delete", "ON")?;
    connection.execute(DELETE_OLDER_ROWS_SQL, [cutoff_second])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, UNIX_EPOCH};

    use rusqlite::Connection;

    use super::{LOGS_DATABASE_FILE_NAME, expire_account_home_logs};

    // Codex's `logs` table as its log database holds it.
    const LOGS_TABLE_SQL: &str = "CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, \
         ts INTEGER NOT NULL, ts_nanos INTEGER NOT NULL, level TEXT NOT NULL, \
         target TEXT NOT NULL, feedback_log_body TEXT, module_path TEXT, file TEXT, line INTEGER, \
         thread_id TEXT, process_uuid TEXT, estimated_bytes INTEGER NOT NULL DEFAULT 0)";

    const CUTOFF_SECOND: i64 = 1_800_000_000;

    // Rows written a second before the cutoff's second go and the rest stay, a row in the cutoff's
    // own second among them, as Codex's `<` keeps it; a home with no log database is no failure
    // and is left without one. Killed by `<=`, by the cutoff rounded up to its next second, by a
    // cutoff in milliseconds, and by an absent database made or refused.
    #[test]
    fn rows_before_the_cutoff_go_and_an_absent_database_is_left_absent() {
        let home = tempfile::tempdir().expect("the home is made");
        let database = home.path().join(LOGS_DATABASE_FILE_NAME);
        let connection = Connection::open(&database).expect("the fixture opens");
        connection
            .execute_batch(&format!("PRAGMA journal_mode = WAL; {LOGS_TABLE_SQL}"))
            .expect("the table is made");
        for ts in [CUTOFF_SECOND - 1, CUTOFF_SECOND, CUTOFF_SECOND + 1] {
            connection
                .execute(
                    "INSERT INTO logs (ts, ts_nanos, level, target) VALUES (?1, 0, 'INFO', 't')",
                    [ts],
                )
                .expect("the row is written");
        }
        let cutoff = UNIX_EPOCH
            + Duration::from_secs(CUTOFF_SECOND.unsigned_abs())
            + Duration::from_millis(500);

        expire_account_home_logs(home.path(), cutoff).expect("the rows are deleted");

        let kept: Vec<i64> = connection
            .prepare("SELECT ts FROM logs ORDER BY ts")
            .and_then(|mut statement| {
                statement
                    .query_map([], |row| row.get(0))?
                    .collect::<rusqlite::Result<_>>()
            })
            .expect("the rows read");
        assert_eq!(kept, vec![CUTOFF_SECOND, CUTOFF_SECOND + 1]);

        let empty_home = tempfile::tempdir().expect("the home is made");
        expire_account_home_logs(empty_home.path(), cutoff)
            .expect("an absent database is no fault");
        assert!(!empty_home.path().join(LOGS_DATABASE_FILE_NAME).exists());
    }
}
