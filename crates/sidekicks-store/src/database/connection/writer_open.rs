//! The writer's connection: the daemon's database opened or created with the pragmas that make a
//! commit durable, and its schema created once on a file that has none.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use rusqlite::{Connection, ErrorCode, Transaction, TransactionBehavior};

use crate::database::connection::setup::{apply_connection_pragmas, prepare_or_close};
use crate::database::schema::{DatabaseSchema, SESSION_EVENTS_TABLE};
use sidekicks_std::cleanup_failures::CleanupFailures;

// How long an open waits for another connection's lock, as the busy wait and as the switch to
// WAL's own retries.
const BUSY_WAIT: Duration = Duration::from_secs(5);

// How long the switch to WAL waits between its retries.
const WAL_SWITCH_RETRY_WAIT: Duration = Duration::from_millis(10);

/// The optimize the writer runs at open and daily after: its mask has SQLite weigh every table,
/// not only those this connection's own statements planned, since the reads plan on the read
/// pool's connections, and analyze each under SQLite's temporary limit of 2000 rows, so no run
/// scans a whole table while the writer waits on it.
pub(crate) const OPTIMIZE_SQL: &str = "PRAGMA optimize = 0x10012";

// Whether the file holds the schema; it is created whole, so its event log stands for every table.
const HAS_SCHEMA_SQL: &str =
    "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)";

/// Why the writer's database did not open.
#[derive(Debug, thiserror::Error)]
pub enum DatabaseOpenError {
    /// SQLite refused a step of the open.
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    /// A durability pragma read back other than it was set, as a build flag can make it.
    #[error("the database's {pragma} reads back other than the writer set it")]
    PragmaNotTaken {
        /// The pragma.
        pragma: &'static str,
    },
    /// The file holds a schema another build made, which this build never migrates.
    #[error("the database at {} holds the schema of another build", .path.display())]
    SchemaFromAnotherBuild {
        /// The database file.
        path: PathBuf,
    },
}

/// The service's store's file name in its data folder.
pub const DAEMON_DATABASE_FILE_NAME: &str = "daemon.db";

/// The search index's folder name in the data folder, beside the store whose rows it indexes.
pub const SEARCH_INDEX_FOLDER_NAME: &str = "search-index";

/// Opens the database at `database_path` for its one writer, creating the file and `schema` when
/// they are missing. Fails as SQLite does, with [`DatabaseOpenError::PragmaNotTaken`] for a
/// durability pragma that reads back other than it was set, or with
/// [`DatabaseOpenError::SchemaFromAnotherBuild`] for a file whose fingerprint is not `schema`'s;
/// the connection is closed first, with the close's own failure beside the original when that
/// fails.
pub fn open_database(
    database_path: &Path,
    schema: &DatabaseSchema,
) -> Result<Connection, CleanupFailures<DatabaseOpenError, rusqlite::Error>> {
    let connection = Connection::open(database_path).map_err(|open_failure| {
        CleanupFailures::new(open_failure.into(), Vec::new(), "opening the database")
    })?;
    prepare_or_close(connection, |connection| {
        apply_writer_pragmas(connection)?;
        create_schema_once(connection, database_path, schema)?;
        // Once at open, as SQLite advises for a long-lived connection; the daily run is the
        // scheduler's.
        connection.execute_batch(OPTIMIZE_SQL)?;
        Ok(())
    })
}

// The writer's pragmas, set before any transaction, since the journal mode and foreign keys do not
// change inside one. The busy wait comes first, so a second daemon opening the same fresh file
// waits out the first one's switch to WAL rather than failing busy. A commit syncs the log, and a
// checkpoint syncs with the drive's full flush on macOS, so a power loss cannot damage the file.
// Foreign keys hold at every write, and a deleted row is overwritten with zeros, so a purge leaves
// nothing readable. Each is read back, since SQLite keeps its mode when it cannot take one and a
// build flag can change a default.
fn apply_writer_pragmas(connection: &Connection) -> Result<(), DatabaseOpenError> {
    set_writer_pragmas(connection)?;
    read_writer_pragmas_back(connection)
}

// The switch to WAL upgrades the read transaction it opens into a write one, and SQLite never
// runs the busy handler on that upgrade, so two daemons opening one fresh file race it and the
// loser is told busy at once; it tries again until the busy wait is spent.
fn switch_to_wal(connection: &Connection) -> Result<(), DatabaseOpenError> {
    let started = Instant::now();
    loop {
        match connection.pragma_update(None, "journal_mode", "WAL") {
            Ok(()) => return Ok(()),
            Err(rusqlite::Error::SqliteFailure(failure, _))
                if failure.code == ErrorCode::DatabaseBusy && started.elapsed() < BUSY_WAIT =>
            {
                std::thread::sleep(WAL_SWITCH_RETRY_WAIT);
            }
            Err(error) => return Err(error.into()),
        }
    }
}

fn set_writer_pragmas(connection: &Connection) -> Result<(), DatabaseOpenError> {
    connection.pragma_update(
        None,
        "busy_timeout",
        i64::try_from(BUSY_WAIT.as_millis()).expect("the busy wait fits SQLite's integer"),
    )?;
    switch_to_wal(connection)?;
    connection.pragma_update(None, "synchronous", "FULL")?;
    connection.pragma_update(None, "checkpoint_fullfsync", "ON")?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "secure_delete", "ON")?;
    apply_connection_pragmas(connection)?;
    Ok(())
}

fn read_writer_pragmas_back(connection: &Connection) -> Result<(), DatabaseOpenError> {
    let journal_mode: String =
        connection.pragma_query_value(None, "journal_mode", |row| row.get(0))?;
    if journal_mode != "wal" {
        return Err(DatabaseOpenError::PragmaNotTaken {
            pragma: "journal_mode",
        });
    }
    for (pragma, expected) in [
        (
            "busy_timeout",
            i64::try_from(BUSY_WAIT.as_millis()).expect("the busy wait fits SQLite's integer"),
        ),
        ("synchronous", 2),
        ("checkpoint_fullfsync", 1),
        ("foreign_keys", 1),
        ("secure_delete", 1),
    ] {
        let value: i64 = connection.pragma_query_value(None, pragma, |row| row.get(0))?;
        if value != expected {
            return Err(DatabaseOpenError::PragmaNotTaken { pragma });
        }
    }
    Ok(())
}

// Creates the schema on a file that has none, with its fingerprint, and on a file that has one
// checks the fingerprint. The check runs again inside a `BEGIN IMMEDIATE` transaction, which takes
// the write lock up front: two daemons racing on one file serialize there, and the second sees the
// first's schema and commits nothing. A deferred transaction would let both read, then both try to
// write, and WAL answers that with a busy snapshot the busy wait cannot resolve. The whole schema
// commits at once, so the event log exists exactly when every table does.
fn create_schema_once(
    connection: &Connection,
    database_path: &Path,
    schema: &DatabaseSchema,
) -> Result<(), DatabaseOpenError> {
    if has_schema(connection)? {
        return check_fingerprint(connection, database_path, schema);
    }
    let transaction = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)?;
    if has_schema(&transaction)? {
        check_fingerprint(&transaction, database_path, schema)?;
    } else {
        transaction.execute_batch(schema.sql())?;
        transaction.pragma_update(None, "user_version", schema.fingerprint())?;
    }
    Ok(transaction.commit()?)
}

fn has_schema(connection: &Connection) -> rusqlite::Result<bool> {
    connection.query_row(HAS_SCHEMA_SQL, [SESSION_EVENTS_TABLE], |row| row.get(0))
}

// Refuses a file whose schema another build made: this build never migrates it.
fn check_fingerprint(
    connection: &Connection,
    database_path: &Path,
    schema: &DatabaseSchema,
) -> Result<(), DatabaseOpenError> {
    let fingerprint: i32 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if fingerprint == schema.fingerprint() {
        return Ok(());
    }
    Err(DatabaseOpenError::SchemaFromAnotherBuild {
        path: database_path.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::path::Path;

    use rusqlite::Connection;
    use rusqlite::types::Value;

    use super::{DatabaseOpenError, open_database};
    use crate::database::schema::{DatabaseSchema, SESSION_EVENTS_TABLE, schema_parts};

    fn store_schema() -> DatabaseSchema {
        schema_parts().into_schema()
    }

    fn table_names(connection: &Connection) -> BTreeSet<String> {
        connection
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .expect("the table list prepares")
            .query_map([], |row| row.get(0))
            .expect("the table list reads")
            .collect::<rusqlite::Result<_>>()
            .expect("each table name reads")
    }

    fn pragma_value(connection: &Connection, pragma: &str) -> Value {
        connection
            .pragma_query_value(None, pragma, |row| row.get(0))
            .expect("the pragma reads")
    }

    fn schema_version(database_path: &Path) -> i64 {
        Connection::open(database_path)
            .expect("the test opens the file")
            .query_row("PRAGMA schema_version", [], |row| row.get(0))
            .expect("the schema version reads")
    }

    /// A fresh file opens durable, with foreign keys on and deletes zeroed. Mutation: drop a
    /// pragma.
    #[test]
    fn a_fresh_file_opens_durable() {
        let folder = tempfile::tempdir().expect("the test makes a temporary folder");
        let connection = open_database(&folder.path().join("daemon.db"), &store_schema())
            .expect("the fresh file opens");

        assert_eq!(
            pragma_value(&connection, "journal_mode"),
            Value::Text("wal".to_owned())
        );
        for (pragma, expected) in [
            ("synchronous", 2),
            ("checkpoint_fullfsync", 1),
            ("trusted_schema", 0),
            ("foreign_keys", 1),
            ("secure_delete", 1),
        ] {
            assert_eq!(
                pragma_value(&connection, pragma),
                Value::Integer(expected),
                "{pragma}"
            );
        }
    }

    /// A schema that fails partway creates nothing: the whole script runs in one transaction. A
    /// table the schema creates late is made first, so its statement fails after the event log's.
    /// Mutation: run the script outside the transaction.
    #[test]
    fn a_failed_schema_leaves_no_table_behind() {
        let folder = tempfile::tempdir().expect("the test makes a temporary folder");
        let database_path = folder.path().join("daemon.db");
        Connection::open(&database_path)
            .expect("the test opens the file")
            .execute_batch("CREATE TABLE provider_account_usage_windows (id TEXT)")
            .expect("the conflicting table is made");

        open_database(&database_path, &store_schema())
            .expect_err("the schema's own table is already there");

        let connection = Connection::open(&database_path).expect("the test opens the file");
        assert_eq!(
            table_names(&connection),
            BTreeSet::from(["provider_account_usage_windows".to_owned()])
        );
    }

    /// A second open of a file with the schema changes nothing and keeps its rows. Mutation: drop
    /// the check for an existing schema.
    #[test]
    fn a_second_open_commits_nothing_and_keeps_the_rows() {
        let folder = tempfile::tempdir().expect("the test makes a temporary folder");
        let database_path = folder.path().join("daemon.db");
        open_database(&database_path, &store_schema())
            .expect("the fresh file opens")
            .execute(
                "INSERT INTO session_drafts (session_id, text, updated_at)
                 VALUES ('session', 'half typed', '2026-10-18T09:00:00.000Z')",
                [],
            )
            .expect("a row is written");
        let version_before = schema_version(&database_path);

        let connection =
            open_database(&database_path, &store_schema()).expect("the file opens again");

        assert_eq!(schema_version(&database_path), version_before);
        let text: String = connection
            .query_row("SELECT text FROM session_drafts", [], |row| row.get(0))
            .expect("the row is kept");
        assert_eq!(text, "half typed");
    }

    /// Two daemons opening one fresh file at once both open it, over one schema. Mutations: open
    /// a deferred transaction, or drop the check inside it.
    #[test]
    fn two_opens_racing_on_a_fresh_file_both_succeed_over_one_schema() {
        let folder = tempfile::tempdir().expect("the test makes a temporary folder");
        let database_path = folder.path().join("daemon.db");
        let barrier = std::sync::Barrier::new(2);
        let schema = store_schema();

        let outcomes: Vec<_> = std::thread::scope(|scope| {
            let opens: Vec<_> = (0..2)
                .map(|_| {
                    scope.spawn(|| {
                        barrier.wait();
                        open_database(&database_path, &schema).map(drop)
                    })
                })
                .collect();
            opens
                .into_iter()
                .map(|open| open.join().expect("the opening thread ends"))
                .collect()
        });

        for outcome in outcomes {
            outcome.expect("each racing open succeeds");
        }
        let connection = Connection::open(&database_path).expect("the test opens the file");
        let event_logs: i64 = connection
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name = ?1",
                [SESSION_EVENTS_TABLE],
                |row| row.get(0),
            )
            .expect("the schema reads");
        assert_eq!(event_logs, 1);
    }

    /// A file whose schema another build made is refused by name, never migrated or started on.
    /// Mutation: drop the fingerprint check on a file that holds a schema.
    #[test]
    fn a_file_from_another_build_is_refused() {
        let folder = tempfile::tempdir().expect("the test makes a temporary folder");
        let database_path = folder.path().join("daemon.db");
        let schema = store_schema();
        open_database(&database_path, &schema)
            .expect("the fresh file opens")
            .pragma_update(None, "user_version", schema.fingerprint() ^ 1)
            .expect("the file takes another build's fingerprint");

        let refusal =
            open_database(&database_path, &schema).expect_err("the other build's file is refused");

        assert!(
            matches!(
                refusal.original(),
                DatabaseOpenError::SchemaFromAnotherBuild { path } if *path == database_path
            ),
            "{refusal}"
        );
    }
}
