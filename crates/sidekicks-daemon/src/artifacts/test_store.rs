//! The artifact services' test store: a database file with the daemon's schema holding one session
//! and one of its runs, the writer, the event log's appender and the read pool on it, and folders
//! for the spool and the stored payloads.

use std::path::Path;
use std::sync::Arc;

use rusqlite::{Connection, named_params};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::WallClockTimer;
use tempfile::TempDir;

use crate::artifacts::admission::UploadAdmission;
use crate::artifacts::payload_store::PayloadStore;
use crate::artifacts::publish::ArtifactPublishService;
use crate::artifacts::refusals::ArtifactError;
use crate::artifacts::schema::ARTIFACT_STATEMENT_CAPACITY;
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::DatabaseWriter;
use crate::database::writer::test_file::{TestDatabase, test_session_id};
use crate::events::log_service::EventLogService;
use crate::events::log_service::tests::open_log;
use crate::events::session::appender::SessionEventAppender;
use crate::events::session::version::SESSION_EVENT_VERSION;
use crate::session::directory::test_rows::insert_session_row;
use sidekicks_contracts::wire::id::mint_uuid_v7;

/// Free room the test volume reports: far more than any test writes.
const TEST_VOLUME_FREE_BYTES: u64 = 1 << 40;

/// A database with one session and one of its runs, and the services' shared pieces over it.
pub(crate) struct ArtifactTestStore {
    /// The database file.
    pub(crate) database: TestDatabase,
    /// The writer on the database.
    pub(crate) writer: Arc<DatabaseWriter>,
    /// The event log on the database, through the same writer.
    pub(crate) event_log: Arc<EventLogService>,
    /// The appender on the database's event log, through the same writer.
    pub(crate) appender: Arc<SessionEventAppender>,
    /// The read pool on the database.
    pub(crate) reads: Arc<DatabaseReadPool>,
    /// The payload store in its own folder.
    pub(crate) payloads: Arc<PayloadStore>,
    /// The upload admission over its own spool folder.
    pub(crate) admission: Arc<UploadAdmission>,
    /// The seeded session.
    pub(crate) session_id: SessionId,
    /// The seeded run, one of the session's.
    pub(crate) run_id: RunId,
    // Held only so the temporary folder lives as long as the store.
    _folder: TempDir,
}

impl ArtifactTestStore {
    /// Opens the store with its session and run written.
    pub(crate) async fn open() -> Self {
        let database = TestDatabase::new();
        let session_id = test_session_id();
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        let log = open_log(&database, None).await;
        seed_owner(
            &database.reader(),
            session_id.text().as_str(),
            run_id.text().as_str(),
        );
        let folder = tempfile::tempdir().expect("the test makes a temporary folder");
        Self {
            writer: log.writer,
            appender: Arc::new(SessionEventAppender::new(
                Arc::clone(&log.service),
                SESSION_EVENT_VERSION.clone(),
            )),
            event_log: log.service,
            reads: Arc::new(DatabaseReadPool::new(
                database.path(),
                ARTIFACT_STATEMENT_CAPACITY,
            )),
            payloads: Arc::new(
                PayloadStore::new(folder.path().join("objects"))
                    .expect("the test makes the payload store"),
            ),
            admission: Arc::new(UploadAdmission::new(
                folder.path().join("spool"),
                |_folder| Ok(TEST_VOLUME_FREE_BYTES),
            )),
            session_id,
            run_id,
            database,
            _folder: folder,
        }
    }

    /// The publication service over the store's pieces, on the machine's wall clock.
    pub(crate) fn publisher(&self) -> ArtifactPublishService {
        ArtifactPublishService::new(
            Arc::clone(&self.appender),
            Arc::clone(&self.reads),
            Arc::clone(&self.payloads),
            Arc::clone(&self.admission),
            Arc::new(WallClockTimer::new().expect("the test arms a wall clock")),
        )
    }

    /// The folder the admission spools into.
    pub(crate) fn spool_folder(&self) -> &Path {
        self.admission.spool_folder()
    }

    /// How many rows `table` holds, read on a connection of the test's own.
    pub(crate) fn count_rows(&self, table: &str) -> i64 {
        self.database
            .reader()
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .expect("the test counts a table's rows")
    }

    /// How many events of `event_type` the log holds, read on a connection of the test's own.
    pub(crate) fn count_events(&self, event_type: &str) -> i64 {
        self.database
            .reader()
            .query_row(
                "SELECT count(*) FROM session_events WHERE type = ?1",
                [event_type],
                |row| row.get(0),
            )
            .expect("the test counts the log's events")
    }

    /// The one text column `sql` reads for each row it matches with `parameter` as `?1`, read on a
    /// connection of the test's own.
    pub(crate) fn read_rows(&self, sql: &str, parameter: &str) -> Vec<String> {
        let reader = self.database.reader();
        let mut statement = reader.prepare(sql).expect("the test's read prepares");
        statement
            .query_map([parameter], |row| row.get(0))
            .expect("the test reads its rows")
            .collect::<rusqlite::Result<_>>()
            .expect("each row reads as text")
    }

    /// How many files sit in the spool folder; none when it was never made.
    pub(crate) fn spooled_file_count(&self) -> usize {
        match std::fs::read_dir(self.spool_folder()) {
            Ok(entries) => entries.count(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
            Err(error) => panic!("the test reads the spool folder: {error}"),
        }
    }
}

// The session and its run the checks look for.
fn seed_owner(connection: &Connection, session_id: &str, run_id: &str) {
    insert_session_row(connection, session_id, None, None);
    connection
        .execute(
            "INSERT INTO runs (run_id, session_id, state, run_version) \
             VALUES (@runId, @sessionId, @state, 0)",
            named_params! {
                "@runId": run_id,
                "@sessionId": session_id,
                "@state": <&'static str>::from(RunState::Running),
            },
        )
        .expect("the test stores a run");
}

/// The refusal code `failure` carries, or `None` for a fault that is no refusal.
pub(crate) fn refusal_code_of(failure: &ArtifactError) -> Option<RefusalCode> {
    failure.refusal().map(|refusal| refusal.code)
}
