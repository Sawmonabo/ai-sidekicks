//! The test log every test of a log reader opens: the event log service on a test database, the
//! writer it appends through and the followers it publishes to.

use std::sync::Arc;

use tokio::sync::oneshot;

use super::{
    EVENT_LOG_STATEMENT_CAPACITY, EventLogService, EventLogServiceDependencies, ProjectionError,
    ProjectionStatements,
};
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::statement::WriteStatement;
use crate::database::writer::test_file::TestDatabase;
use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions, WritesHeldError};
use crate::events::session::appender::UnsequencedEventEnvelope;
use crate::events::session::followers::SessionEventFollowers;

/// A test's event log: the service, the writer it appends through and the followers it publishes
/// to.
pub struct TestLog {
    /// The writer every append goes through.
    pub writer: Arc<DatabaseWriter>,
    /// The followers each committed write is published to.
    pub followers: Arc<SessionEventFollowers>,
    /// The service on the test's database.
    pub service: Arc<EventLogService>,
}

/// The event log on `database`, its writer holding its writes until `writes_held_until` answers,
/// or committing each as it comes when that is `None`.
pub async fn open_log(
    database: &TestDatabase,
    writes_held_until: Option<oneshot::Receiver<Result<(), WritesHeldError>>>,
) -> TestLog {
    let options = DatabaseWriterOptions {
        writes_held_until,
        ..DatabaseWriterOptions::default()
    };
    open_log_with(database, options).await
}

/// The event log on `database`, its writer opened with `options`.
pub async fn open_log_with(database: &TestDatabase, options: DatabaseWriterOptions) -> TestLog {
    open_log_projecting(database, options, None).await
}

/// The event log on `database` whose appends each carry `projection_statements`' statements for
/// the event in its own write, as the daemon's projections do, each committed as it comes.
pub async fn open_projected_log(
    database: &TestDatabase,
    projection_statements: impl Fn(
        &UnsequencedEventEnvelope,
    ) -> Result<Vec<WriteStatement>, ProjectionError>
    + Send
    + Sync
    + 'static,
) -> TestLog {
    let projection_statements: Box<ProjectionStatements> = Box::new(projection_statements);
    open_log_projecting(
        database,
        DatabaseWriterOptions::default(),
        Some(projection_statements),
    )
    .await
}

async fn open_log_projecting(
    database: &TestDatabase,
    options: DatabaseWriterOptions,
    projection_statements: Option<Box<ProjectionStatements>>,
) -> TestLog {
    let writer = Arc::new(
        DatabaseWriter::open(database.opener(), options)
            .await
            .expect("the writer opens its database"),
    );
    let followers = Arc::new(SessionEventFollowers::default());
    let service = Arc::new(EventLogService::new(EventLogServiceDependencies {
        writer: Arc::clone(&writer),
        pool: Arc::new(DatabaseReadPool::new(
            database.path(),
            EVENT_LOG_STATEMENT_CAPACITY,
        )),
        followers: Arc::clone(&followers),
        projection_statements,
        refuse_session_write: None,
        read_damaged_from_sequence: None,
    }));
    TestLog {
        writer,
        followers,
        service,
    }
}
