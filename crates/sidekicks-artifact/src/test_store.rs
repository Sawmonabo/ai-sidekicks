//! The artifact services' test store: a database file with the daemon's schema holding one session
//! and one of its runs, the writer, the event log's appender and the read pool on it, and folders
//! for the spool and the stored payloads.

use std::borrow::Cow;
#[cfg(test)]
use std::path::Path;
use std::sync::Arc;

use rusqlite::{Connection, named_params};
#[cfg(test)]
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_platforms::WallClockTimer;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::writer::DatabaseWriter;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::events::log_service::EventLogService;
use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log};
use sidekicks_store::events::session::appender::SessionEventAppender;
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;
use tempfile::TempDir;

use crate::admission::UploadAdmission;
use crate::payload_store::{ContentHash, PayloadStore};
use crate::plans::schema::schema_parts;
use crate::publish::ArtifactPublishService;
#[cfg(test)]
use crate::refusals::ArtifactError;
use crate::schema::ARTIFACT_STATEMENT_CAPACITY;

/// Free room the test volume reports: far more than any test writes.
const TEST_VOLUME_FREE_BYTES: u64 = 1 << 40;

/// A database with one session and one of its runs, and the services' shared pieces over it.
pub struct ArtifactTestStore {
    /// The database file.
    pub database: TestDatabase,
    /// The writer on the database.
    pub writer: Arc<DatabaseWriter>,
    /// The event log on the database, through the same writer.
    pub event_log: Arc<EventLogService>,
    /// The appender on the database's event log, through the same writer.
    pub appender: Arc<SessionEventAppender>,
    /// The read pool on the database.
    pub reads: Arc<DatabaseReadPool>,
    /// The payload store in its own folder.
    pub(crate) payloads: Arc<PayloadStore>,
    /// The upload admission over its own spool folder.
    pub(crate) admission: Arc<UploadAdmission>,
    /// The seeded session.
    pub session_id: SessionId,
    /// The seeded run, one of the session's.
    pub run_id: RunId,
    // Held only so the temporary folder lives as long as the store.
    _folder: TempDir,
}

impl ArtifactTestStore {
    /// Opens the store with its session and run written.
    pub async fn open() -> Self {
        let database = TestDatabase::new(schema_parts());
        let log = open_log(&database, None).await;
        Self::open_on(database, log)
    }

    /// The store on `database` and its event log `log`, with its session and run written.
    pub fn open_on(database: TestDatabase, log: TestLog) -> Self {
        let session_id = test_session_id();
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
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
    pub fn publisher(&self) -> ArtifactPublishService {
        ArtifactPublishService::new(
            Arc::clone(&self.appender),
            Arc::clone(&self.reads),
            Arc::clone(&self.payloads),
            Arc::clone(&self.admission),
            Arc::new(WallClockTimer::new().expect("the test arms a wall clock")),
        )
    }

    /// The folder the admission spools into.
    #[cfg(test)]
    pub(crate) fn spool_folder(&self) -> &Path {
        self.admission.spool_folder()
    }

    /// How many rows `table` holds, read on a connection of the test's own.
    #[cfg(test)]
    pub(crate) fn count_rows(&self, table: &str) -> i64 {
        self.database
            .reader()
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .expect("the test counts a table's rows")
    }

    /// How many events of `event_type` the log holds, read on a connection of the test's own.
    #[cfg(test)]
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
    #[cfg(test)]
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
    #[cfg(test)]
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
#[cfg(test)]
pub(crate) fn refusal_code_of(failure: &ArtifactError) -> Option<RefusalCode> {
    failure.refusal().map(|refusal| refusal.code)
}

/// Writes a manifest of `session_id` over `content_hash` and its payload reference.
pub async fn write_payload_reference(
    writer: &DatabaseWriter,
    session_id: SessionId,
    content_hash: &ContentHash,
) {
    let manifest_id = mint_uuid_v7().to_string();
    let reference_id = mint_uuid_v7().to_string();
    writer
        .write(vec![
            WriteStatement {
                sql: Cow::Borrowed(
                    "INSERT INTO artifact_manifests (id, session_id, artifact_type, \
                     content_hash, size_bytes, created_at) VALUES (@manifestId, @sessionId, \
                     'file', @contentHash, 1, '2026-10-19T09:00:00.000Z')",
                ),
                bindings: StatementBindings::Named(vec![
                    text_binding("@manifestId", &manifest_id),
                    text_binding("@sessionId", session_id.text().as_str()),
                    text_binding("@contentHash", content_hash.as_str()),
                ]),
                expected_row_count: Some(1),
            },
            WriteStatement {
                sql: Cow::Borrowed(
                    "INSERT INTO artifact_payload_refs (id, manifest_id, storage_path, \
                     media_type, size_bytes, created_at) VALUES (@referenceId, @manifestId, \
                     @contentHash, 'text/plain', 1, '2026-10-19T09:00:00.000Z')",
                ),
                bindings: StatementBindings::Named(vec![
                    text_binding("@referenceId", &reference_id),
                    text_binding("@manifestId", &manifest_id),
                    text_binding("@contentHash", content_hash.as_str()),
                ]),
                expected_row_count: Some(1),
            },
        ])
        .await
        .expect("the test's manifest is written");
}
