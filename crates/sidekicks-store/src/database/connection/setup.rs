//! A connection's setup: what every connection to the daemon's database holds, a read-only
//! connection opened with it, and a connection closed when its setup fails. It holds nothing of the
//! writer, so a thread or process that only reads loads none of it.

use std::path::Path;

use rusqlite::{Connection, OpenFlags};
use sidekicks_std::cleanup_failures::CleanupFailures;

/// Applies what every connection to the daemon's database holds: a page cache of at most 2,000
/// KiB, so a large purge or a full read of the session list stays within it on each connection; a
/// check of each b-tree page as it is first read from disk, so a damaged page fails the read that
/// meets it rather than spreading; and a schema trusted to call only SQLite's own harmless
/// functions, since the daemon registers none.
pub(crate) fn apply_connection_pragmas(connection: &Connection) -> rusqlite::Result<()> {
    connection.pragma_update(None, "cache_size", -2000)?;
    connection.pragma_update(None, "cell_size_check", "ON")?;
    connection.pragma_update(None, "trusted_schema", "OFF")
}

/// Opens a read-only connection on an existing database, set up as the writer's is, keeping
/// SQLite's busy wait, with room for `statement_capacity` cached statements, the size of the
/// statement set it runs. Fails when the file is missing, closing the connection when its setup
/// fails.
pub fn open_database_reader(
    database_path: &Path,
    statement_capacity: usize,
) -> Result<Connection, CleanupFailures<rusqlite::Error>> {
    let connection = Connection::open_with_flags(
        database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|open_failure| {
        CleanupFailures::new(open_failure, Vec::new(), "opening the database")
    })?;
    connection.set_prepared_statement_cache_capacity(statement_capacity);
    prepare_or_close(connection, apply_connection_pragmas)
}

/// Runs `prepare` on a connection just opened and returns it. When `prepare` fails, the connection
/// is closed and the failure returned, with the close's own failure beside it when that fails too.
pub(crate) fn prepare_or_close<SetupError>(
    connection: Connection,
    prepare: impl FnOnce(&Connection) -> Result<(), SetupError>,
) -> Result<Connection, CleanupFailures<SetupError, rusqlite::Error>> {
    match prepare(&connection) {
        Ok(()) => Ok(connection),
        Err(setup_failure) => {
            let close_failures = match connection.close() {
                Ok(()) => Vec::new(),
                Err((_, close_failure)) => vec![close_failure],
            };
            Err(CleanupFailures::new(
                setup_failure,
                close_failures,
                "opening the database",
            ))
        }
    }
}
