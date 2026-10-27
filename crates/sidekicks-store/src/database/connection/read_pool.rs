//! The one bounded pool of read-only connections every reading service shares. A read borrows a
//! connection for its whole read transaction and runs on the blocking pool; WAL readers never
//! block each other, so reads run side by side up to the pool's size. A long read first takes a
//! place among one fewer than the pool's connections, so a short read always finds one. A read's
//! place and its hold against the close stay with its connection on the blocking pool, so a read
//! whose caller left keeps both until the connection is back. The pool is closed explicitly, each
//! connection closed so its failure is seen.

use std::future::{Future, ready};
use std::path::PathBuf;
use std::sync::Arc;

use deadpool::managed::{Manager, Metrics, Object, Pool, PoolError, RecycleResult};
use rusqlite::Connection;
use tokio::sync::{RwLock, Semaphore};
use tokio::task::JoinError;

use crate::database::connection::setup::open_database_reader;
use sidekicks_std::cleanup_failures::CleanupFailures;

/// The read-only connections the pool holds at most. It is 4 until a measured workload of short
/// reads beside long ones on the blocking pool sets it.
pub(crate) const READ_POOL_SIZE: usize = 4;

const CLOSE_OPERATION: &str = "closing the database read pool";

/// How long a read holds its connection: a long one (a page of events, a whole log) leaves one
/// connection free for short ones.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadLength {
    /// A read of one row or a few.
    Short,
    /// A read of a page or more.
    Long,
}

/// Why a read did not reach a connection.
#[derive(Debug, thiserror::Error)]
pub enum DatabaseReadError {
    /// The pool was closed before the read borrowed a connection.
    #[error("the database read pool is closed")]
    Closed,
    /// A connection could not be opened for the read.
    #[error("a read-only connection to the database could not be opened")]
    Open(#[source] ReadConnectionOpenError),
    /// The blocking task that ran the read did not finish.
    #[error("the database read did not finish")]
    Join(#[from] JoinError),
}

/// Why a read-only connection could not be opened.
#[derive(Debug, thiserror::Error)]
pub enum ReadConnectionOpenError {
    /// SQLite refused the open or the connection's setup.
    #[error(transparent)]
    Connection(#[from] CleanupFailures<rusqlite::Error>),
    /// The blocking task that opened it did not finish.
    #[error("opening a read-only connection did not finish")]
    Join(#[from] JoinError),
}

/// Why closing the pool failed: the first connection whose close failed, beside the others'.
#[derive(Debug, thiserror::Error)]
pub enum DatabaseReadPoolCloseError {
    /// SQLite refused to close connections.
    #[error(transparent)]
    Connections(#[from] CleanupFailures<rusqlite::Error>),
    /// The blocking task that closed them did not finish.
    #[error("closing the database read pool did not finish")]
    Join(#[from] JoinError),
}

/// Opens each read-only connection on the blocking pool.
struct ReadConnectionManager {
    database_path: PathBuf,
    statement_capacity: usize,
}

impl Manager for ReadConnectionManager {
    type Type = Connection;
    type Error = ReadConnectionOpenError;

    async fn create(&self) -> Result<Connection, ReadConnectionOpenError> {
        let database_path = self.database_path.clone();
        let statement_capacity = self.statement_capacity;
        let connection = tokio::task::spawn_blocking(move || {
            open_database_reader(&database_path, statement_capacity)
        })
        .await??;
        Ok(connection)
    }

    fn recycle(
        &self,
        _connection: &mut Connection,
        _metrics: &Metrics,
    ) -> impl Future<Output = RecycleResult<ReadConnectionOpenError>> + Send {
        // A read leaves no transaction open: its statements reset when they drop.
        ready(Ok(()))
    }
}

/// The daemon's read-only connections to its database, shared by every reading service; see the
/// module doc.
pub struct DatabaseReadPool {
    connections: Pool<ReadConnectionManager>,
    /// The places a long read takes first, one fewer than the pool's connections.
    long_reads: Arc<Semaphore>,
    /// Taken shared by every read and exclusively by the close, which so waits out the reads
    /// running and lets none start after it.
    reads: Arc<RwLock<()>>,
}

impl DatabaseReadPool {
    /// A pool on the existing database at `database_path`; connections open as reads first need
    /// them, so a missing file fails the first read. Each connection caches `statement_capacity`
    /// statements: the sum of every reading service's statement set, which the pool's builder
    /// adds up, so a statement stays prepared on whichever connection a read borrows.
    pub fn new(database_path: PathBuf, statement_capacity: usize) -> Self {
        let connections = Pool::builder(ReadConnectionManager {
            database_path,
            statement_capacity,
        })
        .max_size(READ_POOL_SIZE)
        .build()
        .expect("a pool with no timeouts needs no runtime");
        Self {
            connections,
            long_reads: Arc::new(Semaphore::new(READ_POOL_SIZE - 1)),
            reads: Arc::new(RwLock::new(())),
        }
    }

    /// Runs `read` on a borrowed connection on the blocking pool, the connection held for the
    /// whole read; a [`ReadLength::Long`] read first waits for a place among the long ones. A
    /// caller that leaves once `read` runs leaves it running, its place and connection held until
    /// it ends. Fails with `read`'s own failure, or with [`DatabaseReadError`] when the pool is
    /// closed, a connection does not open or the blocking task does not finish.
    pub async fn read<Output, Failure>(
        &self,
        length: ReadLength,
        read: impl FnOnce(&Connection) -> Result<Output, Failure> + Send + 'static,
    ) -> Result<Output, Failure>
    where
        Output: Send + 'static,
        Failure: From<DatabaseReadError> + Send + 'static,
    {
        let running = Arc::clone(&self.reads).read_owned().await;
        let long_place = match length {
            ReadLength::Short => None,
            ReadLength::Long => Some(
                Arc::clone(&self.long_reads)
                    .acquire_owned()
                    .await
                    .map_err(|_closed| DatabaseReadError::Closed)?,
            ),
        };
        let connection: Object<ReadConnectionManager> =
            self.connections.get().await.map_err(read_error)?;
        tokio::task::spawn_blocking(move || {
            let result = read(&connection);
            // The connection is back in the pool before its place and the close's hold go, so the
            // close never meets it out.
            drop(connection);
            drop(long_place);
            drop(running);
            result
        })
        .await
        .map_err(DatabaseReadError::from)?
    }

    /// Closes the pool once every running read is done, a read whose caller left among them: each
    /// connection, idle once the reads end, is taken back and
    /// closed, and every later read fails with [`DatabaseReadError::Closed`]. A later close does
    /// nothing. Fails with SQLite's refusals of the closes, every connection closed either way.
    pub async fn close(&self) -> Result<(), DatabaseReadPoolCloseError> {
        let _no_reads = self.reads.write().await;
        if self.connections.is_closed() {
            return Ok(());
        }
        let idle = self.connections.retain(|_, _| false).removed;
        self.connections.close();
        self.long_reads.close();
        tokio::task::spawn_blocking(move || {
            let mut failures = idle
                .into_iter()
                .filter_map(|connection| connection.close().err())
                .map(|(_connection, failure)| failure);
            match failures.next() {
                None => Ok(()),
                Some(first) => Err(CleanupFailures::new(
                    first,
                    failures.collect(),
                    CLOSE_OPERATION,
                )),
            }
        })
        .await??;
        Ok(())
    }
}

fn read_error(failure: PoolError<ReadConnectionOpenError>) -> DatabaseReadError {
    match failure {
        PoolError::Backend(open_failure) => DatabaseReadError::Open(open_failure),
        PoolError::Closed => DatabaseReadError::Closed,
        PoolError::Timeout(_) | PoolError::NoRuntimeSpecified | PoolError::PostCreateHook(_) => {
            unreachable!("the pool sets no timeout and no hook")
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::mpsc::Sender;
    use std::time::Duration;

    use tokio::sync::mpsc::UnboundedSender;
    use tokio::task::JoinHandle;
    use tokio::time::timeout;

    use super::{DatabaseReadError, DatabaseReadPool, READ_POOL_SIZE, ReadLength};
    use crate::database::schema::schema_parts;
    use crate::database::writer::test_file::TestDatabase;

    /// Bounds every wait the pool must answer, so a broken limit fails the test.
    const ANSWER_WAIT: Duration = Duration::from_secs(5);

    /// How long the extra long read is watched while every long place is held.
    const PLACE_WATCH: Duration = Duration::from_millis(200);

    /// How long the close is watched while a read still holds a connection.
    const CLOSE_WATCH: Duration = Duration::from_millis(200);

    /// A long read on `pool` that says `index` once it runs and holds its connection until its
    /// release is sent.
    fn hold_long_read(
        pool: &Arc<DatabaseReadPool>,
        index: usize,
        started: &UnboundedSender<usize>,
    ) -> (Sender<()>, JoinHandle<Result<(), DatabaseReadError>>) {
        let (release, released) = std::sync::mpsc::channel::<()>();
        let (pool, started) = (Arc::clone(pool), started.clone());
        let read = tokio::spawn(async move {
            pool.read(ReadLength::Long, move |_connection| {
                started.send(index).expect("the test listens");
                released.recv().expect("the test releases the read");
                Ok(())
            })
            .await
        });
        (release, read)
    }

    #[tokio::test]
    async fn a_read_whose_caller_left_keeps_its_place_and_the_close_waits_for_its_connection() {
        let database = TestDatabase::new(schema_parts());
        drop(database.opener()().expect("the test creates its database"));
        let pool = Arc::new(DatabaseReadPool::new(database.path(), 1));
        let (started_sender, mut started) = tokio::sync::mpsc::unbounded_channel();
        // Long reads fill every long place.
        let (releases, mut long_reads): (Vec<_>, Vec<_>) = (0..READ_POOL_SIZE - 1)
            .map(|index| hold_long_read(&pool, index, &started_sender))
            .unzip();
        for _ in 0..READ_POOL_SIZE - 1 {
            timeout(ANSWER_WAIT, started.recv())
                .await
                .expect("each long read finds a place")
                .expect("a long read starts");
        }
        // The first long read's caller leaves while its read runs.
        let left = long_reads.remove(0);
        left.abort();
        assert!(left.await.expect_err("the caller left").is_cancelled());
        // One more long read waits for a place, since the read whose caller left gave none back.
        let (extra_release, extra_read) = hold_long_read(&pool, READ_POOL_SIZE, &started_sender);
        assert!(
            timeout(PLACE_WATCH, started.recv()).await.is_err(),
            "the extra long read waits for a place"
        );

        let short = timeout(
            ANSWER_WAIT,
            pool.read(ReadLength::Short, |connection| {
                let seven: i64 = connection
                    .query_row("SELECT 7", [], |row| row.get(0))
                    .expect("the short read runs");
                Ok::<_, DatabaseReadError>(seven)
            }),
        )
        .await
        .expect("the short read finds a connection");
        assert_eq!(short.expect("the short read runs"), 7);

        for release in releases.iter().skip(1).chain([&extra_release]) {
            release.send(()).expect("the long read waits");
        }
        for long_read in long_reads.into_iter().chain([extra_read]) {
            timeout(ANSWER_WAIT, long_read)
                .await
                .expect("the long read ends")
                .expect("the long read's task ends")
                .expect("the long read runs");
        }

        let mut close = Box::pin(pool.close());
        assert!(
            timeout(CLOSE_WATCH, &mut close).await.is_err(),
            "the close waits for the connection the left read holds"
        );
        releases[0].send(()).expect("the left read still runs");
        timeout(ANSWER_WAIT, close)
            .await
            .expect("the close ends once the left read's connection is back")
            .expect("the pool closes its connections");
        let after_close = pool
            .read(ReadLength::Short, |_| Ok::<_, DatabaseReadError>(()))
            .await;
        assert!(matches!(after_close, Err(DatabaseReadError::Closed)));
    }
}
