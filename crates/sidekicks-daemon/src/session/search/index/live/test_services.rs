//! The daemon's services a live index starts on, built on a test's database.

use std::sync::Arc;

use sidekicks_platforms::WallClockTimer;

use crate::daemon::scheduler::Scheduler;
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::TestDatabase;
use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use crate::session::search::index::outbox::OUTBOX_STATEMENT_CAPACITY;

/// The read pool, writer and scheduler a live index's start takes, as the daemon makes them.
pub struct TestDaemonServices {
    /// Read connections on the test's file, with the live index's statement capacity.
    pub reads: Arc<DatabaseReadPool>,
    /// A writer on the test's file.
    pub writer: Arc<DatabaseWriter>,
    /// A scheduler on the system's wall-clock timer.
    pub scheduler: Arc<Scheduler>,
}

impl TestDaemonServices {
    /// Opens the writer on `database`, which creates its file, then the read pool and the
    /// scheduler. Panics when the writer or the timer cannot be made.
    pub async fn open(database: &TestDatabase) -> Self {
        let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens its database");
        Self {
            reads: Arc::new(DatabaseReadPool::new(
                database.path(),
                OUTBOX_STATEMENT_CAPACITY,
            )),
            writer: Arc::new(writer),
            scheduler: Arc::new(Scheduler::start(
                Arc::new(WallClockTimer::new().expect("the wall-clock timer is made")),
                None,
                tokio::sync::watch::channel(0).1,
            )),
        }
    }
}
