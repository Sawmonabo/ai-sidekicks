//! The artifact services' test store: a database file holding one session and one of its runs
//! beside the artifact tables, the writer and read pool on it, and folders for the spool and the
//! stored payloads.

use std::path::Path;
use std::sync::Arc;

use rusqlite::{Connection, named_params};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use tempfile::TempDir;

use crate::artifacts::admission::UploadAdmission;
use crate::artifacts::payload_store::PayloadStore;
use crate::artifacts::refusals::ArtifactError;
use crate::artifacts::schema::{ARTIFACT_SCHEMA_SQL, ARTIFACT_STATEMENT_CAPACITY};
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::{TestDatabase, test_session_id};
use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use crate::uuid_v7::mint_uuid_v7;

/// The two columns of the session and run tables the owner checks read.
const OWNER_TABLES_SQL: &str = "
CREATE TABLE sessions (id TEXT PRIMARY KEY) STRICT;
CREATE TABLE runs (run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL) STRICT;
";

/// Free room the test volume reports: far more than any test writes.
const TEST_VOLUME_FREE_BYTES: u64 = 1 << 40;

/// A database with one session and one of its runs, and the services' shared pieces over it.
pub(crate) struct ArtifactTestStore {
    /// The writer on the database.
    pub(crate) writer: Arc<DatabaseWriter>,
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
    database: TestDatabase,
    // Held only so the temporary folder lives as long as the store.
    _folder: TempDir,
}

impl ArtifactTestStore {
    /// Opens the store with its session and run written.
    pub(crate) async fn open() -> Self {
        let database = TestDatabase::new();
        let session_id = test_session_id();
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        let open_events = database.opener();
        let session_text = session_id.text();
        let run_text = run_id.text();
        let opener = move || {
            let connection = open_events()?;
            connection.execute_batch(OWNER_TABLES_SQL)?;
            connection.execute_batch(&ARTIFACT_SCHEMA_SQL)?;
            seed_owner(&connection, session_text.as_str(), run_text.as_str())?;
            Ok::<_, rusqlite::Error>(connection)
        };
        let writer = DatabaseWriter::open(opener, DatabaseWriterOptions::default())
            .await
            .expect("the writer opens its database");
        let folder = tempfile::tempdir().expect("the test makes a temporary folder");
        Self {
            writer: Arc::new(writer),
            reads: Arc::new(DatabaseReadPool::new(
                database.path(),
                ARTIFACT_STATEMENT_CAPACITY,
            )),
            payloads: Arc::new(PayloadStore::new(folder.path().join("objects"))),
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
fn seed_owner(connection: &Connection, session_id: &str, run_id: &str) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO sessions (id) VALUES (@sessionId)",
        named_params! { "@sessionId": session_id },
    )?;
    connection.execute(
        "INSERT INTO runs (run_id, session_id) VALUES (@runId, @sessionId)",
        named_params! { "@runId": run_id, "@sessionId": session_id },
    )?;
    Ok(())
}

/// The refusal code `failure` carries, or `None` for a fault that is no refusal.
pub(crate) fn refusal_code_of(failure: &ArtifactError) -> Option<RefusalCode> {
    match failure {
        ArtifactError::Refused(refusal) => Some(refusal.code),
        ArtifactError::Disk(_)
        | ArtifactError::Interrupted(_)
        | ArtifactError::StreamWriteDropped
        | ArtifactError::Write(_)
        | ArtifactError::Read(_)
        | ArtifactError::Database(_)
        | ArtifactError::WithCleanup(_) => None,
    }
}
