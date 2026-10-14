//! A reading service's one read-only connection: opened once, read on the blocking pool one read
//! at a time, and closed explicitly so the close's failure is seen.

use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use rusqlite::Connection;
use tokio::task::JoinError;

use crate::cleanup_failures::CleanupFailures;
use crate::database::connection::setup::open_database_reader;

/// A reading service's one read-only connection, shared by its reads; a service keeps one and
/// closes it through [`DatabaseReader::close`].
pub(crate) struct DatabaseReader {
    /// `None` once closed.
    connection: Arc<Mutex<Option<Connection>>>,
}

/// Why a read did not reach the connection.
#[derive(Debug, thiserror::Error)]
pub(crate) enum DatabaseReaderError {
    /// The connection was closed before the read ran.
    #[error("the database reader is closed")]
    Closed,
    /// The blocking task that ran the read did not finish.
    #[error("the database read did not finish")]
    Join(#[from] JoinError),
}

/// Why closing the connection failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum DatabaseReaderCloseError {
    /// SQLite refused the close.
    #[error("the database reader's connection did not close")]
    Connection(#[source] rusqlite::Error),
    /// The blocking task that ran the close did not finish.
    #[error("closing the database reader did not finish")]
    Join(#[from] JoinError),
}

impl DatabaseReader {
    /// Opens the connection on the existing database at `database_path`, with room for
    /// `statement_capacity` cached statements. Fails as [`open_database_reader`] does.
    pub(crate) fn open(
        database_path: &Path,
        statement_capacity: usize,
    ) -> Result<Self, CleanupFailures<rusqlite::Error>> {
        Ok(Self {
            connection: Arc::new(Mutex::new(Some(open_database_reader(
                database_path,
                statement_capacity,
            )?))),
        })
    }

    /// Runs `read` on the connection on the blocking pool, once any running read is done. Fails
    /// with `read`'s own failure, or with [`DatabaseReaderError`] when the connection is closed or
    /// the blocking task did not finish.
    pub(crate) async fn read<Output, Failure>(
        &self,
        read: impl FnOnce(&Connection) -> Result<Output, Failure> + Send + 'static,
    ) -> Result<Output, Failure>
    where
        Output: Send + 'static,
        Failure: From<DatabaseReaderError> + Send + 'static,
    {
        let connection = Arc::clone(&self.connection);
        tokio::task::spawn_blocking(move || match &*lock(&connection) {
            Some(connection) => read(connection),
            None => Err(Failure::from(DatabaseReaderError::Closed)),
        })
        .await
        .map_err(DatabaseReaderError::from)?
    }

    /// Closes the connection once any running read is done; a later read fails as closed, and a
    /// later close does nothing. Fails with SQLite's refusal of the close.
    pub(crate) async fn close(&self) -> Result<(), DatabaseReaderCloseError> {
        let connection = Arc::clone(&self.connection);
        tokio::task::spawn_blocking(move || {
            let Some(connection) = lock(&connection).take() else {
                return Ok(());
            };
            // A refused close hands the connection back; its drop repeats the same refused close.
            connection
                .close()
                .map_err(|(_connection, failure)| DatabaseReaderCloseError::Connection(failure))
        })
        .await?
    }
}

/// The connection's lock. A panicked read leaves the connection usable: its statement resets when
/// dropped.
fn lock(connection: &Mutex<Option<Connection>>) -> MutexGuard<'_, Option<Connection>> {
    connection.lock().unwrap_or_else(PoisonError::into_inner)
}
