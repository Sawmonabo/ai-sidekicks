//! The database file's open and close as the daemon's start and stop run them.

use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_platforms::{DaemonRunFolder, Spawner};
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

use super::{DatabaseFile, DatabaseFileStart, close_database_file, open_database_file};
use crate::bootstrap::secure_defaults::{SecureDefaults, SecureDefaultsConfig};
use crate::daemon::process::supervision::ProcessStateTracker;
use crate::database::connection::writer_open::DAEMON_DATABASE_FILE_NAME;
use crate::database::statement::{StatementBindings, WriteStatement};
use crate::database::writer::WriteError;
use crate::database::writer::messages::WriteJob;
use crate::database::writer::test_file::{test_envelope, test_session_id};
use crate::events::log_service::{
    EventAppendError, EventLogAppendOptions, EventReadAfterCursorRequest,
};
use crate::events::session::appender::UnsequencedEventEnvelope;
use crate::ipc::caller_process::system_reader::ProcessTableReader;
use crate::recovery::database_file::copy::DatabaseFileCopier;
use crate::recovery::database_file::damage::read_database_damage;
use crate::recovery::database_file::last_run::{LastRunEnd, read_last_run_end};
use crate::recovery::database_file::sqlite_shell::SqliteShell;
use crate::recovery::database_file::{WRITE_AHEAD_LOG_SUFFIX, sibling_path};

/// The longest a close the tests run may drain.
const CLOSE_BOUND: Duration = Duration::from_secs(4);

/// A data folder and run folder on a scratch home, and what a start opens the file there with.
struct Harness {
    _scratch: TempDir,
    data_folder: PathBuf,
    database_path: PathBuf,
    run_folder: DaemonRunFolder,
    shell: SqliteShell,
    copier: DatabaseFileCopier,
    secure_defaults: SecureDefaults,
    stop: CancellationToken,
}

impl Harness {
    fn new() -> Self {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let data_folder = scratch.path().join("data");
        std::fs::create_dir(&data_folder).expect("the data folder is made");
        let run_path = scratch.path().join("run");
        let run_folder = DaemonRunFolder {
            socket_path: run_path.join("daemon.sock"),
            token_path: run_path.join("daemon.token"),
            status_path: run_path.join("service-status.json"),
            folder_path: run_path,
        };
        let spawner = Spawner::new(tokio::runtime::Handle::current()).expect("the spawner starts");
        let program = std::env::current_exe().expect("the test program names itself");
        let secure_defaults = SecureDefaults::load(SecureDefaultsConfig {
            local_ipc_path: run_folder.socket_path.clone(),
        })
        .expect("the socket's path is short enough");
        Self {
            database_path: data_folder.join(DAEMON_DATABASE_FILE_NAME),
            data_folder,
            run_folder,
            shell: SqliteShell::new(program.clone(), spawner.clone()),
            copier: DatabaseFileCopier::new(program, spawner),
            secure_defaults,
            stop: CancellationToken::new(),
            _scratch: scratch,
        }
    }

    async fn open(&self) -> DatabaseFile {
        open_database_file(DatabaseFileStart {
            database_path: self.database_path.clone(),
            data_folder: self.data_folder.clone(),
            index_folder_path: self.data_folder.join("search-index"),
            shell: &self.shell,
            copier: &self.copier,
            now: jiff::Timestamp::now(),
            backup_folder: None,
            run_folder: &self.run_folder,
            secure_defaults: &self.secure_defaults,
            caller_process_reader: Arc::new(
                ProcessTableReader::for_this_program().expect("the reader builds"),
            ),
            process_state: ProcessStateTracker::new(),
            stop: &self.stop,
        })
        .await
        .expect("the file opens")
    }

    fn log_path(&self) -> PathBuf {
        sibling_path(&self.database_path, WRITE_AHEAD_LOG_SUFFIX)
    }

    async fn last_run(&self) -> LastRunEnd {
        read_last_run_end(&self.database_path)
            .await
            .expect("the record reads")
    }
}

/// `session_id`'s `session.created`, its lead bound to a test provider.
fn session_created(session_id: SessionId) -> UnsequencedEventEnvelope {
    let event = serde_json::from_value(json!({
        "type": "session.created",
        "payload": {
            "sessionId": session_id,
            "shape": "chat",
            "mainAgent": {
                "agentId": mint_uuid_v7().to_string(),
                "name": "lead",
                "binding": {
                    "providerName": "test-provider",
                    "modelId": "test-model",
                    "providerAccountId": null,
                    "effort": null,
                },
                "ancestry": [],
                "createdAt": "2026-10-25T09:00:00.000Z",
            },
        },
    }))
    .expect("the test writes a session.created event");
    test_envelope(session_id, &event)
}

// A stop folds the write-ahead log into the file and records the clean stop, and a start after
// it, vouched for by that record, stops cleanly again. Killed by dropping `record_clean_stop`
// from the close: the record then reads `Unclean`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stop_folds_the_log_into_the_file_and_records_a_clean_stop() {
    let harness = Harness::new();

    let first = harness.open().await;
    let failures = close_database_file(first, CLOSE_BOUND, false).await;
    assert!(failures.is_empty(), "{failures:?}");
    assert!(
        std::fs::metadata(harness.log_path()).map_or(true, |log| log.len() == 0),
        "the stop leaves no log to replay"
    );
    assert_eq!(harness.last_run().await, LastRunEnd::Clean);

    // The clean stop vouches for the file, so the next start's writes go at once.
    let second = harness.open().await;
    second.writer.flush().await;
    let failures = close_database_file(second, CLOSE_BOUND, false).await;
    assert!(failures.is_empty(), "{failures:?}");
    assert_eq!(harness.last_run().await, LastRunEnd::Clean);
}

// The event log the start builds writes a session's directory row in the event's own write, and
// refuses, storing nothing, an event whose projection cannot compose its change: a pin whose time
// folds to before year 0000. Killed by dropping the directory's statements from the chain (no row
// is read) and by mapping the producer's `Err` to no statements (the pin is stored).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_append_writes_its_session_row_and_a_projection_refusal_stores_nothing() {
    let harness = Harness::new();
    let file = harness.open().await;
    let session_id = test_session_id();

    file.event_log
        .append(
            session_created(session_id),
            EventLogAppendOptions::default(),
        )
        .await
        .expect("the creation is stored");
    let pinned = serde_json::from_value(json!({
        "type": "session.pinned",
        "payload": { "sessionId": session_id, "at": "0000-01-01T00:00:00.000+01:00" },
    }))
    .expect("the test writes a session.pinned event");
    let refused = file
        .event_log
        .append(
            test_envelope(session_id, &pinned),
            EventLogAppendOptions::default(),
        )
        .await;

    assert!(
        matches!(refused, Err(EventAppendError::Projection(_))),
        "{refused:?}"
    );
    let stored = file
        .event_log
        .read_after_cursor(EventReadAfterCursorRequest {
            session_id,
            after_cursor: None,
            limit: None,
        })
        .await
        .expect("the log reads");
    assert_eq!(stored.events.len(), 1, "only the creation is stored");
    let connection =
        rusqlite::Connection::open(&harness.database_path).expect("the file opens to read");
    let state: String = connection
        .query_row(
            "SELECT state FROM sessions WHERE id = ?",
            [session_id.to_string()],
            |row| row.get(0),
        )
        .expect("the creation wrote the session's row");
    assert_eq!(state, "provisioning");
    drop(connection);
    let failures = close_database_file(file, CLOSE_BOUND, false).await;
    assert!(failures.is_empty(), "{failures:?}");
}

// Damage found while a vouched file is open ends the writer at once and marks the store failed, and
// the stop then leaves the write-ahead log as it was for the repair, records the damage and records
// no clean stop. Killed by dropping the follower's end (the writer is not ended before the close),
// and, with the follower's end dropped too, by dropping the close's (the close folds the log).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn damage_found_mid_run_ends_the_writer_and_leaves_the_log_for_the_repair() {
    let harness = Harness::new();
    // A new file is vouched for and has nothing to check, so no truncation moves its log.
    let file = harness.open().await;
    file.event_log
        .append(
            session_created(test_session_id()),
            EventLogAppendOptions::default(),
        )
        .await
        .expect("the creation is stored");

    file.damage.find("page 3 is damaged".to_owned());
    tokio::time::timeout(
        CLOSE_BOUND,
        file.writer.when_failed().wait_for(Option::is_some),
    )
    .await
    .expect("the writer ends within the bound")
    .expect("the writer's failure is told");
    assert!(
        file.status.read_daemon_write_refusal(true).is_some(),
        "the store reads failed"
    );
    let log_length = std::fs::metadata(harness.log_path())
        .expect("the run's writes are in the log")
        .len();
    assert!(log_length > 0, "the run's writes are in the log");
    let failures = close_database_file(file, CLOSE_BOUND, false).await;

    assert!(failures.is_empty(), "{failures:?}");
    assert_eq!(
        std::fs::metadata(harness.log_path())
            .expect("the log stays")
            .len(),
        log_length,
        "the close folds nothing into the damaged file"
    );
    assert_eq!(
        read_database_damage(&harness.database_path)
            .await
            .expect("the damage record reads")
            .as_deref(),
        Some("page 3 is damaged")
    );
    assert_ne!(harness.last_run().await, LastRunEnd::Clean);
}

// A stop while the check still walks a file nothing vouches for ends the check and waits for its
// connection to close before the writer closes, so the writer is the file's last connection and
// leaves no log behind, and the writes the check held fail as closed while held; the file stays
// unvouched. Killed by the follower returning at the stop without awaiting the check's answer (the
// check's connection may outlive the writer's), and by the hold's sender dropped before the
// writer's close (the held write fails as the writer's end instead, and the log stays).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stop_during_the_check_waits_for_it_and_closes_the_writer_last() {
    let harness = Harness::new();
    let first = harness.open().await;
    let failures = close_database_file(first, CLOSE_BOUND, false).await;
    assert!(failures.is_empty(), "{failures:?}");
    // Pages enough that the check still walks at the close; the change leaves the file unvouched.
    let connection = rusqlite::Connection::open(&harness.database_path).expect("the file opens");
    connection
        .execute_batch(
            "CREATE TABLE filler (n INTEGER PRIMARY KEY, text TEXT);
             WITH RECURSIVE counter(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM counter
               WHERE n < 20000)
             INSERT INTO filler SELECT n, printf('%.2000c', 'x') FROM counter;",
        )
        .expect("the rows are written");
    drop(connection);

    let file = harness.open().await;
    let held = file
        .writer
        .enqueue(
            WriteJob {
                statements: vec![WriteStatement {
                    sql: Cow::Borrowed("INSERT INTO filler (n, text) VALUES (0, 'held')"),
                    bindings: StatementBindings::Positional(Vec::new()),
                    expected_row_count: None,
                }],
                events: Vec::new(),
            },
            None,
        )
        .expect("the writer takes the write");
    let failures = close_database_file(file, CLOSE_BOUND, false).await;

    assert!(failures.is_empty(), "{failures:?}");
    let held = held.await;
    assert!(matches!(held, Err(WriteError::ClosedWhileHeld)), "{held:?}");
    assert!(
        std::fs::metadata(harness.log_path()).map_or(true, |log| log.len() == 0),
        "the writer closed last and left no log"
    );
    assert_ne!(harness.last_run().await, LastRunEnd::Clean);
}
