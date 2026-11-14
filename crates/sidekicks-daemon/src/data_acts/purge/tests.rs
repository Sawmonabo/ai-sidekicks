//! The purge's tests, by behavior, and the fixture they share: a purge over a fresh database whose
//! file steps all succeed, and the rows and log it reads back.

use std::collections::BTreeSet;
use std::io;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use futures::FutureExt as _;
use rstest::rstest;
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
use sidekicks_mcp::client::McpClient;
use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;
use sidekicks_provider::driver::PROVIDERS;
use sidekicks_provider::driver::contract::MockProviderDriver;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::session_control::SessionCloseCause;
use sidekicks_provider::driver::test_registry::{
    registrations_of_mock_drivers, registry_of_first_provider, test_driver_services,
};
use sidekicks_provider::run::posture::ExecutionPostureService;
use sidekicks_recovery::status::RecoveryStatusTracker;
use sidekicks_recovery::stop_intent::{StopIntent, StopIntentFile};
use sidekicks_session::changes::{
    SESSION_CHANGES_STATEMENT_CAPACITY, SessionChangeError, SessionChanges,
};
use sidekicks_session::conversations::SESSION_CONVERSATIONS_STATEMENT_CAPACITY;
use sidekicks_session::conversations::purge::ConversationPurge;
use sidekicks_session::directory::list_feed::SessionListFeed;
use sidekicks_session::directory::run_activity::ProjectSessionActivityReader;
use sidekicks_session::questions::service::QuestionsService;
use sidekicks_session::readings::context::ContextReadings;
use sidekicks_session::readings::tool_call_status::ToolCallStatuses;
use sidekicks_session::readings::turn::TurnReadings;
use sidekicks_session::related::ranking::SessionRelatedRanking;
use sidekicks_session::run::engine::test_fixture::test_engine;
use sidekicks_session::run::live_count::test_log::counted_log;
use sidekicks_session::service::SessionService;
use sidekicks_shell::test_table::{TableFixture, table_fixture};
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_std::scheduler::budget::ProcessorMeter;
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
use sidekicks_workspace::git::turn_snapshot::capture::GitFloorReports;
use sidekicks_workspace::git::turn_snapshot::repack::CapturePacking;
use sidekicks_workspace::managed::service::ManagedWorkspaceService;
use sidekicks_workspace::project::list_feed::ProjectListFeed;
use sidekicks_workspace::project::records::ProjectRecords;
use sidekicks_workspace::repo::mount::service::{
    REPO_MOUNT_SERVICE_STATEMENT_CAPACITY, RepoMountService,
};
use sidekicks_workspace::repo::root_resolver::RepoRootResolver;
use tempfile::TempDir;
use tokio::sync::{mpsc, watch};

use super::rows::{PurgeCaller, SESSION_PURGE_STATEMENT_CAPACITY};
use super::{SessionPurge, SessionPurgeDeps, SessionPurgeError, SessionPurgeOutcome};
use crate::daemon::release_version::this_build_release_version;
use crate::daemon::schema::schema_parts;

mod erasure;
mod folder_holds;
mod forks;
mod hand_offs;
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
    /// The tool-server client whose connections of a purged session the purge closes.
    pub(crate) mcp_client: Arc<McpClient>,
    pub(crate) _shells: TableFixture,
    /// The data folder the purge removes a session's storage folder from.
    pub(crate) home: TempDir,
}

/// A purge over a fresh database; a provider driver it calls fails the test.
pub(crate) async fn purge_fixture() -> PurgeFixture {
    let providers = Arc::new(ProviderRegistry::register_from(
        &registrations_of_mock_drivers(),
        &test_driver_services(),
    ));
    purge_fixture_over(providers).await
}

/// A purge over a fresh database whose drivers are `providers`.
pub(crate) async fn purge_fixture_over(providers: Arc<ProviderRegistry>) -> PurgeFixture {
    let database = TestDatabase::new(schema_parts());
    let (log, live_runs) = counted_log(&database).await;
    let recovery = Arc::new(RecoveryStatusTracker::new());
    let TestPurge {
        purge,
        truncation,
        mcp_client,
        shells,
        home,
    } = test_purge(&database, &log, Arc::clone(&recovery), providers).await;
    PurgeFixture {
        database,
        log,
        purge,
        truncation,
        live_runs,
        recovery,
        mcp_client,
        _shells: shells,
        home,
    }
}

/// A purge, the truncation it starts, and the tool-server client, shell table and home folder it
/// works in.
pub(crate) struct TestPurge {
    pub(crate) purge: SessionPurge,
    pub(crate) truncation: Arc<WriteAheadLogTruncation>,
    pub(crate) mcp_client: Arc<McpClient>,
    pub(crate) shells: TableFixture,
    pub(crate) home: TempDir,
}

/// A purge on `database` through `log` and the drivers `providers`, clearing removed sessions from
/// `recovery`.
pub(crate) async fn test_purge(
    database: &TestDatabase,
    log: &TestLog,
    recovery: Arc<RecoveryStatusTracker>,
    providers: Arc<ProviderRegistry>,
) -> TestPurge {
    let reads = Arc::new(DatabaseReadPool::new(
        database.path(),
        EVENT_LOG_STATEMENT_CAPACITY
            + SESSION_PURGE_STATEMENT_CAPACITY
            + SESSION_CONVERSATIONS_STATEMENT_CAPACITY
            + APPROVAL_RULES_STATEMENT_CAPACITY
            + ARTIFACT_STATEMENT_CAPACITY
            + REPO_MOUNT_SERVICE_STATEMENT_CAPACITY,
    ));
    let home = tempfile::tempdir().expect("a scratch home");
    let machine_id = MachineId::new("machine".to_owned()).expect("the id is short");
    let (_gate, gate_reader) = watch::channel(true);
    let shells = table_fixture(gate_reader).await;
    let mcp_client = Arc::new(
        McpClient::new(
            Arc::new(PortRegistration::new("questions")),
            this_build_release_version(),
        )
        .expect("the client builds"),
    );

    let changes = Arc::new(SessionChanges::new(
        Arc::new(DatabaseReadPool::new(
            database.path(),
            SESSION_CHANGES_STATEMENT_CAPACITY,
        )),
        Arc::clone(&log.service),
        Arc::clone(&providers),
    ));
    let conversations = Arc::new(ConversationPurge::new(
        Arc::clone(&reads),
        Arc::clone(&providers),
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
        SystemTime::now(),
    ));
    let appender = Arc::new(SessionEventAppender::new(
        Arc::clone(&log.service),
        SESSION_EVENT_VERSION.clone(),
    ));
    let questions = Arc::new(QuestionsService::new(
        Arc::clone(&appender),
        Arc::clone(&reads),
        Arc::clone(&log.writer),
        test_engine(database, Arc::clone(&log.service), home.path()),
        providers,
    ));
    let project_rules = Arc::new(ApprovalRules::new(
        Arc::clone(&reads),
        appender,
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
        transition_lock: Arc::clone(changes.transition_lock()),
        changes,
        shells: Arc::clone(&shells.table),
        mcp_client: Arc::clone(&mcp_client),
        conversations,
        managed_workspaces,
        data_folder: home.path().to_path_buf(),
        packing: Arc::new(CapturePacking::new(
            test_git_runner(),
            Arc::new(GitFloorReports::default()),
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
        tool_call_statuses: Arc::new(ToolCallStatuses::new(Arc::clone(&reads), &log.followers)),
        turn_readings: Arc::new(TurnReadings::new(reads, &log.followers)),
        execution_postures: Arc::new(ExecutionPostureService::new(
            home.path(),
            home.path().join("daemon.token"),
        )),
        questions,
        stop_intent: Arc::new(StopIntentFile::new(&database.path())),
    });
    TestPurge {
        purge,
        truncation,
        mcp_client,
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

// The session's `session.activated`, as its create's finish writes it.
async fn append_activation(log: &TestLog, session_id: SessionId) {
    let event = serde_json::from_value(json!({
        "type": "session.activated",
        "payload": {
            "sessionId": session_id,
            "previousState": "provisioning",
            "newState": "active",
        },
    }))
    .expect("the test writes a session.activated event");
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

// What the first provider's driver was asked, in order.
#[derive(Debug, PartialEq, Eq)]
enum DriverCall {
    CloseSession(SessionCloseCause),
    PurgeSession,
}

// A purge of a damaged session that is still active ends its provider leg, the person the cause,
// before it deletes the provider's conversations, and once its rows are gone drops its name from
// the stop intent, keeping every other name; a leg that will not end refuses the purge with every
// row and every name kept. Killed by the leg loop dropped or run after the delete, by the name's
// drop missing, and by a failed leg swallowed.
#[rstest]
#[case::the_leg_ends_first(true)]
#[case::a_leg_that_will_not_end(false)]
#[tokio::test]
async fn a_purge_ends_its_sessions_legs_and_drops_its_stop_intent_name(#[case] does_leg_end: bool) {
    let calls: Arc<Mutex<Vec<DriverCall>>> = Arc::default();
    let mut driver = MockProviderDriver::new();
    driver.expect_close_session().returning({
        let calls = Arc::clone(&calls);
        move |params| {
            lock(&calls).push(DriverCall::CloseSession(params.cause));
            async move {
                if does_leg_end {
                    Ok(())
                } else {
                    Err(DriverError::Internal(Box::new(io::Error::other(
                        "the leg would not end",
                    ))))
                }
            }
            .boxed()
        }
    });
    driver.expect_purge_session().returning({
        let calls = Arc::clone(&calls);
        move |_params| {
            lock(&calls).push(DriverCall::PurgeSession);
            async { Ok(()) }.boxed()
        }
    });
    let fixture = purge_fixture_over(Arc::new(registry_of_first_provider(Arc::new(driver)))).await;
    // The intent beside the purge's database, the one the purge drops a name from.
    let stop_intent = StopIntentFile::new(&fixture.database.path());
    let reader = fixture.database.reader();
    let session_id = SessionId::try_from(mint_uuid_v7()).expect("a session id");
    let other_session_id = SessionId::try_from(mint_uuid_v7()).expect("a session id");
    store_session(&reader, session_id, SessionState::Active);
    append_event(&fixture.log, session_id, "Read").await;
    let run_id = mint_uuid_v7().to_string();
    reader
        .execute(
            "INSERT INTO runs (run_id, session_id, state, run_version)
             VALUES (?1, ?2, 'completed', 1)",
            params![run_id, session_id.text().as_str()],
        )
        .expect("the test writes the run");
    reader
        .execute(
            "INSERT INTO runtime_bindings
               (id, run_id, provider_name, contract_version, cli_version_raw, resume_handle,
                spawn_config, created_at, updated_at)
             VALUES (?1, ?2, ?3, '1.0.0', '2.1.0', 'conversation',
                     '{\"providerAccountId\":\"account-1\",
                       \"resolvedExecutablePath\":\"/bin/provider\"}',
                     '2026-10-19T09:00:00.000Z', '2026-10-19T09:00:00.000Z')",
            params![mint_uuid_v7().to_string(), run_id, PROVIDERS[0].id],
        )
        .expect("the test writes the binding");
    stop_intent
        .write_whole()
        .await
        .expect("the intent is written");
    let named = BTreeSet::from([session_id, other_session_id]);
    stop_intent
        .name_sessions(&StopIntent::Whole, named.clone())
        .await
        .expect("the intent names the sessions");

    let outcome = only_outcome(
        fixture
            .purge
            .purge(
                &[session_id],
                PurgeCaller::DamagedHistory,
                &ProcessorMeter::default(),
            )
            .await,
    );

    let closed = DriverCall::CloseSession(SessionCloseCause::Person);
    if does_leg_end {
        assert!(
            matches!(outcome, SessionPurgeOutcome::Removed { .. }),
            "the purge finishes, got {outcome:?}"
        );
        assert_eq!(*lock(&calls), [closed, DriverCall::PurgeSession]);
        assert_eq!(state_of(&reader, session_id), None);
        assert_eq!(
            stop_intent.read().await,
            Some(StopIntent::Sessions(BTreeSet::from([other_session_id]))),
            "only the purged session's name is dropped"
        );
    } else {
        assert!(
            matches!(
                outcome,
                SessionPurgeOutcome::Refused(SessionPurgeError::Legs(SessionChangeError::Driver(
                    _
                )))
            ),
            "the leg refuses the purge, got {outcome:?}"
        );
        assert_eq!(*lock(&calls), [closed]);
        assert_eq!(
            state_of(&reader, session_id).as_deref(),
            Some(<&'static str>::from(SessionState::PurgeRequested))
        );
        assert_eq!(event_count(&reader, session_id), 1);
        assert_eq!(
            stop_intent.read().await,
            Some(StopIntent::Sessions(named)),
            "a refused purge keeps every name"
        );
    }
}
