//! The recovery pass's test fixture: a test database whose event log refuses writes as the
//! pass's recovery state says, with a projection that folds `session.pinned` and writes nothing,
//! so a stale session's runs stand as the test wrote them and one broken row damages its history.

use std::error::Error;
use std::fs;
use std::sync::{Arc, Mutex, Weak};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rusqlite::params;
use serde_json::{Value, json};
use sidekicks_approval::permission_asks::{PermissionAsks, PermissionAsksDeps};
use sidekicks_approval::permission_check::test_fixture::test_permission_check;
use sidekicks_approval::run_blocking::ApprovalRunEnd;
use sidekicks_approval::service::test_fixture::test_approval_service;
use sidekicks_artifact::plans::service::PlansService;
use sidekicks_artifact::plans::store::StoredPlanHolds;
use sidekicks_artifact::test_store::ArtifactTestStore;
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::machine::id::MachineId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_platforms::{Spawner, harness_test_name, pass_through_start};
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::test_registry::test_driver_services;
use sidekicks_session::run::engine::RunEngine;
use sidekicks_session::run::engine::test_fixture::{insert_running_run, test_engine_with};
use sidekicks_session::run::live_count::count_live_runs_after_commits;
use sidekicks_session::service::SessionService;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::damage::DatabaseDamageWatch;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::statement::{DATABASE_NOW_SQL, WriteStatement};
use sidekicks_store::database::writer::test_file::{
    TestDatabase, session_event_row, test_run_id, test_session_id,
};
use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use sidekicks_store::events::log_service::test_fixture::TestLog;
use sidekicks_store::events::log_service::{
    EVENT_LOG_STATEMENT_CAPACITY, EventLogService, EventLogServiceDependencies,
};
use sidekicks_store::events::projection::{
    ProjectionContradiction, SessionProjection, SessionProjectionFold,
};
use sidekicks_store::events::session::followers::SessionEventFollowers;
use sidekicks_workspace::run_setup_gates::RunSetupGate;
use tempfile::TempDir;
use tokio::runtime::Handle;
use tokio::sync::watch;

use crate::damaged_history::{DamagedHistory, DamagedHistoryDeps, DamagedSessionPurge};
use crate::database_file::copy::{DATABASE_COPY_MODE, DatabaseFileCopier};
use crate::projection_rebuild::{ProjectionRebuildService, mark_stale_statement};
use crate::restart_settle::{RestartSettle, RestartSettleDeps};
use crate::session_write_refusal::refuse_session_event;
use crate::startup::{StartupRecovery, StartupRecoveryDeps};
use crate::status::RecoveryStatusTracker;

// Statements every pool of the pass caches; a cache size, not a bound on what runs.
const TEST_STATEMENT_CAPACITY: usize = 64;

/// The test the pass's database copy runs as.
const COPY_STAND_IN: &str = "a_database_copy_stand_in_copies_its_file";

// The `database copy` mode's stand-in: copies the source the mode's arguments name to their copy's
// path, as the mode does.
#[test]
#[ignore = "run only as the database copy the pass's repair starts"]
fn a_database_copy_stand_in_copies_its_file() {
    let arguments: Vec<_> = std::env::args_os().collect();
    let mode_end = arguments
        .windows(2)
        .position(|pair| pair[0] == DATABASE_COPY_MODE[0] && pair[1] == DATABASE_COPY_MODE[1])
        .expect("the copy is started in the database copy mode")
        + DATABASE_COPY_MODE.len();
    let [source, destination] = &arguments[mode_end..] else {
        panic!("the copy names its source and its copy's path: {arguments:?}");
    };
    fs::copy(source, destination).expect("the stand-in copies the file");
}

// Folds `session.pinned` and writes no row, so a rebuild leaves the test's rows as they stand.
struct PinnedEvents;

impl SessionProjection for PinnedEvents {
    fn name(&self) -> &'static str {
        "pinned events"
    }

    fn event_types(&self) -> &[SessionEventType] {
        &[SessionEventType::SessionPinned]
    }

    fn clear_statements(&self, _session_id: &SessionId) -> Vec<WriteStatement> {
        Vec::new()
    }

    fn fold(&self, _session_id: &SessionId) -> Box<dyn SessionProjectionFold> {
        Box::new(PinnedEvents)
    }
}

impl SessionProjectionFold for PinnedEvents {
    fn apply(
        &mut self,
        _envelope: &EventEnvelope,
        _event: &SessionEvent,
        _statements: &mut Vec<WriteStatement>,
    ) -> Result<(), ProjectionContradiction> {
        Ok(())
    }
}

/// A purge that removes nothing and keeps each session it was asked to purge, in order.
#[derive(Default)]
pub(crate) struct RecordedPurges {
    /// The sessions asked for.
    pub(crate) session_ids: Mutex<Vec<SessionId>>,
}

impl DamagedSessionPurge for RecordedPurges {
    fn purge_damaged_session(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        self.session_ids
            .lock()
            .expect("no purge panics while it records")
            .push(session_id);
        async { Ok(()) }.boxed()
    }
}

/// The store with its seeded session and running run, the services the pass settles through, the
/// recovery state the event log refuses by, and the writer's count of live runs.
pub(crate) struct PassFixture {
    /// The store, its session and its running run.
    pub(crate) store: ArtifactTestStore,
    /// The run engine every settle goes through.
    pub(crate) engine: Arc<RunEngine>,
    /// The recovery state the event log refuses by.
    pub(crate) status: Arc<RecoveryStatusTracker>,
    /// The writer's count of live runs.
    pub(crate) live_runs: watch::Receiver<u32>,
    /// The data folder the store's files are copied aside into.
    pub(crate) data_folder: TempDir,
    /// The purges damaged history asked for.
    pub(crate) purges: Arc<RecordedPurges>,
    _home: TempDir,
}

impl PassFixture {
    /// The fixture over a fresh database.
    pub(crate) async fn new() -> Self {
        let database = TestDatabase::new(
            sidekicks_approval::schema::schema_parts()
                .with_parts(sidekicks_artifact::plans::schema::schema_parts())
                .with_parts(sidekicks_workflow::schema::schema_parts()),
        );
        let status = Arc::new(RecoveryStatusTracker::new());
        let (after_commit, live_runs) = count_live_runs_after_commits();
        let writer = Arc::new(
            DatabaseWriter::open(
                database.opener(),
                DatabaseWriterOptions {
                    after_commits: vec![after_commit],
                    ..DatabaseWriterOptions::default()
                },
            )
            .await
            .expect("the writer opens its database"),
        );
        let followers = Arc::new(SessionEventFollowers::default());
        let refusing = Arc::clone(&status);
        let damaged_reads = Arc::clone(&status);
        let service = Arc::new(EventLogService::new(EventLogServiceDependencies {
            writer: Arc::clone(&writer),
            pool: Arc::new(DatabaseReadPool::new(
                database.path(),
                EVENT_LOG_STATEMENT_CAPACITY,
            )),
            followers: Arc::clone(&followers),
            projection_statements: None,
            refuse_session_write: Some(Box::new(move |session_id, event_type| {
                refuse_session_event(&refusing, session_id, event_type)
            })),
            read_damaged_from_sequence: Some(Arc::new(move |session_id: &SessionId| {
                damaged_reads.read_damaged_from_sequence(session_id)
            })),
        }));
        let log = TestLog {
            writer,
            followers,
            service,
        };
        let store = ArtifactTestStore::open_on(database, log);
        let home = tempfile::tempdir().expect("the test makes a home folder");
        // Its cancels never move a run, so its holds reach no engine.
        let (run_end_approvals, _run_holds) = test_approval_service(
            &store.database,
            Arc::clone(&store.event_log),
            Arc::clone(&store.appender),
            Arc::clone(&store.writer),
            Weak::new(),
        );
        let permission_check = test_permission_check(
            &store.database.path(),
            &store.appender,
            &store.writer,
            &run_end_approvals,
            home.path(),
        );
        let permission_asks = Arc::new(PermissionAsks::new(PermissionAsksDeps {
            reads: Arc::clone(&store.reads),
            approvals: Arc::clone(&run_end_approvals),
            check: permission_check.check,
            rules: permission_check.rules,
            providers: Arc::new(ProviderRegistry::register_from(
                &[],
                &test_driver_services(),
            )),
        }));
        let engine = test_engine_with(
            &store.database,
            Arc::clone(&store.event_log),
            home.path(),
            Arc::new(StoredPlanHolds),
            vec![
                Arc::new(ApprovalRunEnd::new(run_end_approvals, permission_asks))
                    as Arc<dyn RunSetupGate>,
            ],
        );
        let data_folder = tempfile::tempdir().expect("the test makes a data folder");
        Self {
            store,
            engine,
            status,
            live_runs,
            data_folder,
            purges: Arc::new(RecordedPurges::default()),
            _home: home,
        }
    }

    /// The pass over the fixture's services, moving `status`.
    pub(crate) fn pass(&self, status: Arc<RecoveryStatusTracker>) -> StartupRecovery {
        let store = &self.store;
        let services = self.services(Arc::clone(&status));
        StartupRecovery::new(StartupRecoveryDeps {
            machine_id: MachineId::new("machine-1".to_owned()).expect("the test's machine id"),
            reads: services.reads,
            writer: Arc::clone(&store.writer),
            appender: Arc::clone(&store.appender),
            projection_rebuild: services.projection_rebuild,
            damaged_history: services.damaged_history,
            restart_settle: services.restart_settle,
            status,
            damage: services.damage,
            database_path: store.database.path(),
            data_folder: self.data_folder.path().to_path_buf(),
            copier: Arc::new(DatabaseFileCopier::with_stand_in(
                pass_through_start(&harness_test_name(module_path!(), COPY_STAND_IN)),
                Spawner::new(Handle::current()).expect("the spawner starts"),
            )),
        })
    }

    /// Damaged history over the fixture's services, reading the fixture's recovery state.
    pub(crate) fn damaged_history(&self) -> Arc<DamagedHistory> {
        self.services(Arc::clone(&self.status)).damaged_history
    }

    fn services(&self, status: Arc<RecoveryStatusTracker>) -> RecoveryServices {
        let store = &self.store;
        let reads = Arc::new(DatabaseReadPool::new(
            store.database.path(),
            TEST_STATEMENT_CAPACITY,
        ));
        let reads_status = Arc::clone(&status);
        let session_events = Arc::new(SessionService::new(
            Arc::clone(&reads),
            Arc::new(move |session_id: &SessionId| {
                reads_status.read_damaged_from_sequence(session_id)
            }),
            Arc::new(|_: &ProviderId| None),
        ));
        let damage = Arc::new(DatabaseDamageWatch::new());
        let projection_rebuild = Arc::new(ProjectionRebuildService::new(
            Arc::clone(&reads),
            Arc::clone(&store.writer),
            Arc::clone(&session_events),
            Arc::clone(&damage),
            vec![Box::new(PinnedEvents)],
        ));
        let (approvals, _run_holds) = test_approval_service(
            &store.database,
            Arc::clone(&store.event_log),
            Arc::clone(&store.appender),
            Arc::clone(&store.writer),
            Arc::downgrade(&self.engine),
        );
        let restart_settle = Arc::new(RestartSettle::new(RestartSettleDeps {
            reads: Arc::clone(&reads),
            appender: Arc::clone(&store.appender),
            run_engine: Arc::clone(&self.engine),
            approvals,
            plans: Arc::new(self.plans()),
        }));
        let damaged_history = Arc::new(DamagedHistory::new(DamagedHistoryDeps {
            reads: Arc::clone(&reads),
            session_events,
            appender: Arc::clone(&store.appender),
            writer: Arc::clone(&store.writer),
            projection_rebuild: Arc::clone(&projection_rebuild),
            restart_settle: Arc::clone(&restart_settle),
            purge: Arc::clone(&self.purges) as Arc<dyn DamagedSessionPurge>,
            status,
        }));
        RecoveryServices {
            reads,
            damage,
            projection_rebuild,
            restart_settle,
            damaged_history,
        }
    }

    /// The plans service over the store.
    pub(crate) fn plans(&self) -> PlansService {
        PlansService::new(
            Arc::new(self.store.publisher()),
            Arc::clone(&self.store.appender),
            Arc::clone(&self.store.reads),
        )
    }

    /// A new session with a session row and no events.
    pub(crate) fn new_session(&self) -> SessionId {
        let session_id = test_session_id();
        insert_session_row(
            &self.store.database.reader(),
            session_id.text().as_str(),
            None,
            None,
        );
        session_id
    }

    /// A session the last start left stale, holding `count` pinned events, its row at
    /// `broken_at` no event, and a running run.
    pub(crate) async fn stale_session(
        &self,
        count: usize,
        broken_at: Option<i64>,
    ) -> (SessionId, RunId) {
        let session_id = self.new_session();
        self.store
            .writer
            .append_events(
                (0..count).map(|_| session_event_row(&session_id)).collect(),
                Vec::new(),
            )
            .await
            .expect("the session's events are stored");
        self.store
            .writer
            .write(vec![mark_stale_statement(&session_id)])
            .await
            .expect("the session's cursor is stale");
        if let Some(sequence) = broken_at {
            self.store
                .database
                .reader()
                .execute(
                    "UPDATE session_events SET payload = '[]'
                      WHERE session_id = ?1 AND sequence = ?2",
                    params![session_id.text().as_str(), sequence],
                )
                .expect("the test breaks the stored row");
        }
        let run_id = test_run_id();
        insert_running_run(&self.store.database, session_id, run_id);
        (session_id, run_id)
    }

    /// The payloads of every `event_type` event of `session_id`, in log order.
    pub(crate) fn payloads(
        &self,
        session_id: &SessionId,
        event_type: SessionEventType,
    ) -> Vec<Value> {
        self.store
            .database
            .reader()
            .prepare(
                "SELECT payload FROM session_events WHERE session_id = ?1 AND type = ?2
                  ORDER BY sequence",
            )
            .expect("the test reads the log")
            .query_map(
                params![session_id.text().as_str(), event_type.as_str()],
                |row| row.get::<_, String>(0),
            )
            .expect("the log reads")
            .map(|payload| {
                serde_json::from_str(&payload.expect("a payload reads")).expect("a payload is JSON")
            })
            .collect()
    }

    /// The newest sequence of `session_id`'s log, `None` when it holds none.
    pub(crate) fn head(&self, session_id: &SessionId) -> Option<i64> {
        self.store
            .database
            .reader()
            .query_row(
                "SELECT MAX(sequence) FROM session_events WHERE session_id = ?1",
                [session_id.text().as_str()],
                |row| row.get(0),
            )
            .expect("the head reads")
    }

    /// The state `table`'s row `id` holds.
    pub(crate) fn state(&self, table: &str, id: &str) -> String {
        self.store
            .database
            .reader()
            .query_row(
                &format!("SELECT state FROM {table} WHERE id = ?1"),
                [id],
                |row| row.get(0),
            )
            .expect("the row's state reads")
    }

    /// Records an intervention of `kind` on `run_id` in `state`, with its stored `record`.
    pub(crate) fn record_intervention(
        &self,
        run_id: RunId,
        kind: &str,
        state: &str,
        record: &str,
    ) -> String {
        let id = mint_uuid_v7().to_string();
        self.store
            .database
            .reader()
            .execute(
                &format!(
                    "INSERT INTO interventions (id, target_run_id, type, state, payload, device_id,
                       expected_run_version, client_idempotency_key, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, 'phone', 1, ?1, {DATABASE_NOW_SQL})"
                ),
                params![id, run_id.text().as_str(), kind, state, record],
            )
            .expect("the test records the intervention");
        id
    }

    /// Records a pending ask of `run_id` in `session_id`.
    pub(crate) fn record_pending_ask(&self, session_id: SessionId, run_id: RunId) -> String {
        let id = mint_uuid_v7().to_string();
        self.store
            .database
            .reader()
            .execute(
                &format!(
                    "INSERT INTO approval_requests (id, session_id, run_id, requested_by, category,
                       scope, resource_descriptor, created_at, updated_at)
                     VALUES (?1, ?2, ?3, 'agent-1', 'toolExecution', 'npm test', ?4,
                       {DATABASE_NOW_SQL}, {DATABASE_NOW_SQL})"
                ),
                params![
                    id,
                    session_id.text().as_str(),
                    run_id.text().as_str(),
                    json!({
                        "subject": "npm test",
                        "standingAllowOffered": true,
                        "projectScopeOffered": true,
                        "editable": true,
                        "action": {"kind": "command", "command": "npm test"},
                    })
                    .to_string(),
                ],
            )
            .expect("the test records the ask");
        id
    }

    /// Appends `event`, a session event's `type` and `payload` as JSON, through the engine.
    pub(crate) async fn append(&self, session_id: SessionId, event: Value) {
        let event: SessionEvent = serde_json::from_value(event).expect("the test's event reads");
        sidekicks_session::run::engine::test_fixture::append(&self.engine, session_id, &event)
            .await;
    }
}

// The services the pass and damaged history share.
struct RecoveryServices {
    reads: Arc<DatabaseReadPool>,
    damage: Arc<DatabaseDamageWatch>,
    projection_rebuild: Arc<ProjectionRebuildService>,
    restart_settle: Arc<RestartSettle>,
    damaged_history: Arc<DamagedHistory>,
}
