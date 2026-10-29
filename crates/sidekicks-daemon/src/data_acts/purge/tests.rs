//! The purge's tests, by behavior, and the fixture they share: a purge over a fresh database whose
//! file steps all succeed, and the rows and log it reads back.

use std::sync::Arc;

use futures::FutureExt as _;
use rusqlite::{Connection, params};
use serde_json::json;
use sidekicks_approval::rules::{APPROVAL_RULES_STATEMENT_CAPACITY, ApprovalRules};
use sidekicks_artifact::payload_store::PayloadStore;
use sidekicks_artifact::plans::store::StoredPlanHolds;
use sidekicks_artifact::schema::ARTIFACT_STATEMENT_CAPACITY;
use sidekicks_contracts::event::envelope::DAEMON_SCOPE_SENTINEL_SESSION_ID;
use sidekicks_contracts::machine::id::MachineId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::test_registry::test_driver_services;
use sidekicks_provider::driver::{PROVIDERS, ProviderRegistration};
use sidekicks_recovery::status::RecoveryStatusTracker;
use sidekicks_session::conversation_purge::{
    CONVERSATION_PURGE_STATEMENT_CAPACITY, ConversationPurge,
};
use sidekicks_session::directory::list_feed::SessionListFeed;
use sidekicks_session::directory::run_activity::ProjectSessionActivityReader;
use sidekicks_session::readings::context::ContextReadings;
use sidekicks_session::readings::turn::TurnReadings;
use sidekicks_session::related::ranking::SessionRelatedRanking;
use sidekicks_session::run::live_count::test_log::counted_log;
use sidekicks_session::service::SessionService;
use sidekicks_shell::test_table::{TableFixture, table_fixture};
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::wal_truncation::WriteAheadLogTruncation;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_envelope};
use sidekicks_store::events::log_service::test_fixture::TestLog;
use sidekicks_store::events::log_service::{EVENT_LOG_STATEMENT_CAPACITY, EventLogAppendOptions};
use sidekicks_store::events::session::appender::SessionEventAppender;
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;
use sidekicks_workspace::event_emitter::WorkspaceEventEmitter;
use sidekicks_workspace::git::process::test_git_runner;
use sidekicks_workspace::git::turn_snapshot::service::{
    TURN_SNAPSHOT_PRUNE_STATEMENT_CAPACITY, TurnSnapshotService,
};
use sidekicks_workspace::managed::service::ManagedWorkspaceService;
use sidekicks_workspace::project::list_feed::ProjectListFeed;
use sidekicks_workspace::project::records::ProjectRecords;
use sidekicks_workspace::repo::mount::service::{
    REPO_MOUNT_SERVICE_STATEMENT_CAPACITY, RepoMountService,
};
use sidekicks_workspace::repo::root_resolver::RepoRootResolver;
use tempfile::TempDir;
use tokio::sync::{mpsc, watch};

use super::rows::SESSION_PURGE_STATEMENT_CAPACITY;
use super::{SessionPurge, SessionPurgeDeps, SessionPurgeOutcome};
use crate::daemon::schema::schema_parts;

mod erasure;
mod races_and_failures;

// Text no row of the daemon writes on its own, and shorter than a body the log stores compressed.
const MARKER: &str = "purge-marker-7f3a9c51";

/// A purge over a fresh database whose file steps all succeed, and what it writes through.
pub(crate) struct PurgeFixture {
    pub(crate) database: TestDatabase,
    pub(crate) log: TestLog,
    pub(crate) purge: SessionPurge,
    pub(crate) truncation: Arc<WriteAheadLogTruncation>,
    /// The writer's count of live runs.
    pub(crate) live_runs: watch::Receiver<u32>,
    /// The recovery state the purge clears a removed session from.
    pub(crate) recovery: Arc<RecoveryStatusTracker>,
    pub(crate) _shells: TableFixture,
    pub(crate) _home: TempDir,
}

/// A purge over a fresh database; a provider driver it calls fails the test.
pub(crate) async fn purge_fixture() -> PurgeFixture {
    let database = TestDatabase::new(schema_parts());
    let (log, live_runs) = counted_log(&database).await;
    let recovery = Arc::new(RecoveryStatusTracker::new());
    let TestPurge {
        purge,
        truncation,
        shells,
        home,
    } = test_purge(&database, &log, Arc::clone(&recovery)).await;
    PurgeFixture {
        database,
        log,
        purge,
        truncation,
        live_runs,
        recovery,
        _shells: shells,
        _home: home,
    }
}

/// A purge, the truncation it starts, and the shell table and home folder it works in.
pub(crate) struct TestPurge {
    pub(crate) purge: SessionPurge,
    pub(crate) truncation: Arc<WriteAheadLogTruncation>,
    pub(crate) shells: TableFixture,
    pub(crate) home: TempDir,
}

/// A purge on `database` through `log`, clearing removed sessions from `recovery`; a provider
/// driver it calls fails the test.
pub(crate) async fn test_purge(
    database: &TestDatabase,
    log: &TestLog,
    recovery: Arc<RecoveryStatusTracker>,
) -> TestPurge {
    let reads = Arc::new(DatabaseReadPool::new(
        database.path(),
        EVENT_LOG_STATEMENT_CAPACITY
            + SESSION_PURGE_STATEMENT_CAPACITY
            + CONVERSATION_PURGE_STATEMENT_CAPACITY
            + APPROVAL_RULES_STATEMENT_CAPACITY
            + ARTIFACT_STATEMENT_CAPACITY
            + TURN_SNAPSHOT_PRUNE_STATEMENT_CAPACITY
            + REPO_MOUNT_SERVICE_STATEMENT_CAPACITY,
    ));
    let home = tempfile::tempdir().expect("a scratch home");
    let machine_id = MachineId::new("machine".to_owned()).expect("the id is short");
    let (_gate, gate_reader) = watch::channel(true);
    let shells = table_fixture(gate_reader).await;

    // A driver with no expectations fails the test on any call.
    let table: Vec<ProviderRegistration> = PROVIDERS
        .iter()
        .map(|descriptor| ProviderRegistration {
            descriptor,
            build: |_| Arc::new(MockProviderDriver::new()),
        })
        .collect();
    let services = test_driver_services();
    let conversations = Arc::new(ConversationPurge::new(
        Arc::clone(&reads),
        Arc::new(ProviderRegistry::register_from(&table, &services)),
    ));

    let list_feed = SessionListFeed::for_test(database, &log.followers);
    let repo_mounts = Arc::new(RepoMountService::new(
        Arc::clone(&log.writer),
        Arc::clone(&reads),
        Arc::new(WorkspaceEventEmitter::new(Arc::clone(&log.service))),
        RepoRootResolver::new(test_git_runner()),
        machine_id.clone(),
    ));
    let (writes, _unread_writes) = mpsc::channel(64);
    let managed_workspaces = Arc::new(ManagedWorkspaceService::new(
        home.path(),
        None,
        repo_mounts,
        test_git_runner(),
        writes,
        list_feed.clone(),
    ));
    let project_rules = Arc::new(ApprovalRules::new(
        Arc::clone(&reads),
        Arc::new(SessionEventAppender::new(
            Arc::clone(&log.service),
            SESSION_EVENT_VERSION.clone(),
        )),
        machine_id.clone(),
        Box::new(|_rule| async { Ok(()) }.boxed()),
        Arc::new(ShellLineReadingBound::new(1024)),
    ));
    let truncation = Arc::new(WriteAheadLogTruncation::new(Arc::clone(&log.writer)));
    // Nothing subscribes to the project list, so it reads nothing.
    let projects = ProjectRecords::new(
        Arc::clone(&reads),
        Arc::new(ProjectSessionActivityReader::new(&StoredPlanHolds)),
    );
    let purge = SessionPurge::new(SessionPurgeDeps {
        writer: Arc::clone(&log.writer),
        reads: Arc::clone(&reads),
        event_log: Arc::clone(&log.service),
        machine_id,
        transition_lock: Arc::new(KeyedLock::new()),
        shells: Arc::clone(&shells.table),
        conversations,
        managed_workspaces,
        snapshots: Arc::new(TurnSnapshotService::new(
            test_git_runner(),
            Arc::clone(&reads),
            &home.path().join("execution-roots"),
        )),
        project_rules,
        list_feed,
        project_list_feed: Arc::new(ProjectListFeed::new(Arc::new(projects), &log.followers)),
        ranking: Arc::new(SessionRelatedRanking::new(
            Arc::clone(&reads),
            Arc::clone(&log.writer),
        )),
        payloads: Arc::new(
            PayloadStore::new(home.path().join("objects")).expect("the payload store opens"),
        ),
        truncation: Arc::clone(&truncation),
        recovery,
        sessions: Arc::new(SessionService::new(
            Arc::clone(&reads),
            Arc::new(|_: &SessionId| None),
            Arc::new(|_: &ProviderId| None),
        )),
        context_readings: Arc::new(ContextReadings::new(Arc::clone(&reads), &log.followers)),
        turn_readings: Arc::new(TurnReadings::new(reads, &log.followers)),
    });
    TestPurge {
        purge,
        truncation,
        shells,
        home,
    }
}

/// Stores a chat session in `state`.
pub(crate) fn store_session(connection: &Connection, session_id: SessionId, state: SessionState) {
    insert_session_row(connection, session_id.text().as_str(), None, None);
    connection
        .execute(
            "UPDATE sessions SET state = ?1 WHERE id = ?2",
            params![<&'static str>::from(state), session_id.text().as_str()],
        )
        .expect("the test sets the session's state");
}

// An event of the session's log naming `tool`.
async fn append_event(log: &TestLog, session_id: SessionId, tool: &str) {
    let event = serde_json::from_value(json!({
        "type": "agent.toolCall.invoked",
        "payload": {
            "sessionId": session_id,
            "runId": mint_uuid_v7().to_string(),
            "toolName": tool,
        },
    }))
    .expect("the test writes an agent.toolCall.invoked event");
    log.service
        .append(
            test_envelope(session_id, &event),
            EventLogAppendOptions::default(),
        )
        .await
        .expect("the event is appended");
}

fn count(connection: &Connection, sql: &str, session_id: SessionId) -> i64 {
    connection
        .query_row(sql, [session_id.text().as_str()], |row| row.get(0))
        .expect("the test counts rows")
}

fn event_count(connection: &Connection, session_id: SessionId) -> i64 {
    count(
        connection,
        "SELECT COUNT(*) FROM session_events WHERE session_id = ?1",
        session_id,
    )
}

fn state_of(connection: &Connection, session_id: SessionId) -> Option<String> {
    connection
        .query_row(
            "SELECT state FROM sessions WHERE id = ?1",
            [session_id.text().as_str()],
            |row| row.get(0),
        )
        .ok()
}

// The removed sessions the sentinel's receipts name, as `(session, from, to)`.
fn receipts(connection: &Connection) -> Vec<(String, u64, u64)> {
    let mut statement = connection
        .prepare(
            "SELECT payload FROM session_events WHERE session_id = ?1
               AND type = 'session.event.compacted' ORDER BY sequence",
        )
        .expect("the test's read prepares");
    statement
        .query_map([DAEMON_SCOPE_SENTINEL_SESSION_ID.text().as_str()], |row| {
            row.get::<_, String>(0)
        })
        .expect("the test reads the receipts")
        .flat_map(|payload| {
            let payload: serde_json::Value =
                serde_json::from_str(&payload.expect("a payload reads")).expect("a JSON payload");
            payload["removedSessions"]
                .as_array()
                .expect("a receipt names its sessions")
                .iter()
                .map(|removed| {
                    (
                        removed["sessionId"].as_str().expect("a session").to_owned(),
                        removed["fromSeq"].as_u64().expect("a first sequence"),
                        removed["toSeq"].as_u64().expect("a last sequence"),
                    )
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

fn only_outcome(report: super::SessionPurgeReport) -> SessionPurgeOutcome {
    let mut outcomes = report.outcomes;
    assert_eq!(outcomes.len(), 1, "one session was asked for");
    outcomes.remove(0).1
}
