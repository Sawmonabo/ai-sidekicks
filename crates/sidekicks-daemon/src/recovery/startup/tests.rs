//! The recovery pass over a test database whose event log refuses writes as the pass's recovery
//! state says, with a projection that folds `session.pinned` and writes nothing, so a stale
//! session's runs stand as the test wrote them and one broken row damages its history.

use std::fs;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::params;
use serde_json::{Value, json};
use sidekicks_contracts::event::envelope::{DAEMON_SCOPE_SENTINEL_SESSION_ID, EventEnvelope};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::machine::id::MachineId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::event_cursor::START_OF_LOG_POSITION;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_platforms::Spawner;
use tempfile::TempDir;
use tokio::runtime::Handle;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::{StartupRecovery, StartupRecoveryDeps};
use crate::approvals::service::tests::{SETTLE_WAIT, test_approval_service};
use crate::artifacts::test_store::ArtifactTestStore;
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::statement::{DATABASE_NOW_SQL, WriteStatement};
use crate::database::writer::test_file::{TestDatabase, session_event_row, test_session_id};
use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use crate::events::log_service::tests::TestLog;
use crate::events::log_service::{
    EVENT_LOG_STATEMENT_CAPACITY, EventLogService, EventLogServiceDependencies,
};
use crate::events::session::append_lock::SESSION_APPEND_LOCK;
use crate::events::session::followers::SessionEventFollowers;
use crate::plans::service::PlansService;
use crate::provider::port::plan::ProviderPlan;
use crate::recovery::damaged_history::{DamagedHistory, DamagedHistoryDeps};
use crate::recovery::database_file::copy::DatabaseFileCopier;
use crate::recovery::database_file::damage::DatabaseDamageWatch;
use crate::recovery::projection_rebuild::{
    ProjectionContradiction, ProjectionRebuildService, SessionProjection, SessionProjectionFold,
    mark_stale_statement,
};
use crate::recovery::restart_settle::{RESTART_FAILURE_DETAIL, RestartSettle, RestartSettleDeps};
use crate::recovery::session_write_refusal::{refuse_call_naming_session, refuse_session_event};
use crate::recovery::status::RecoveryStatusTracker;
use crate::session::directory::test_rows::insert_session_row;
use crate::session::run::engine::RunEngine;
use crate::session::run::engine::tests::{insert_running_run, stored_run_state, test_engine};
use crate::session::run::live_count::count_live_runs_after_commits;
use crate::session::service::SessionService;

// Statements every pool of the pass caches; a cache size, not a bound on what runs.
const TEST_STATEMENT_CAPACITY: usize = 64;

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

// The store with its seeded session and running run, the services the pass settles through, the
// recovery state the event log refuses by, and the writer's count of live runs.
struct PassFixture {
    store: ArtifactTestStore,
    engine: Arc<RunEngine>,
    status: Arc<RecoveryStatusTracker>,
    live_runs: watch::Receiver<u32>,
    data_folder: TempDir,
    _home: TempDir,
}

impl PassFixture {
    async fn new() -> Self {
        let database = TestDatabase::new();
        let status = Arc::new(RecoveryStatusTracker::new());
        let (after_commit, live_runs) = count_live_runs_after_commits();
        let writer = Arc::new(
            DatabaseWriter::open(
                database.opener(),
                DatabaseWriterOptions {
                    after_commit: Some(after_commit),
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
        let store = ArtifactTestStore::open_on(
            database,
            TestLog {
                writer,
                followers,
                service,
            },
        );
        let home = tempfile::tempdir().expect("the test makes a home folder");
        let engine = test_engine(&store.database, Arc::clone(&store.event_log), home.path());
        let data_folder = tempfile::tempdir().expect("the test makes a data folder");
        // The copy mode's arguments are `database copy <source> <destination>`.
        let copier = data_folder.path().join("copy");
        fs::write(&copier, "#!/bin/sh\ncp \"$3\" \"$4\"\n").expect("the copier is written");
        fs::set_permissions(&copier, fs::Permissions::from_mode(0o755)).expect("the copier runs");
        Self {
            store,
            engine,
            status,
            live_runs,
            data_folder,
            _home: home,
        }
    }

    // The pass over the fixture's services, moving `status`.
    fn pass(&self, status: Arc<RecoveryStatusTracker>) -> StartupRecovery {
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
            projection_rebuild: Arc::clone(&projection_rebuild),
        }));
        StartupRecovery::new(StartupRecoveryDeps {
            machine_id: MachineId::new("machine-1".to_owned()).expect("the test's machine id"),
            reads,
            writer: Arc::clone(&store.writer),
            appender: Arc::clone(&store.appender),
            projection_rebuild,
            damaged_history,
            restart_settle,
            status,
            damage,
            database_path: store.database.path(),
            data_folder: self.data_folder.path().to_path_buf(),
            copier: Arc::new(DatabaseFileCopier::new(
                self.data_folder.path().join("copy"),
                Spawner::new(Handle::current()).expect("the spawner starts"),
            )),
        })
    }

    fn plans(&self) -> PlansService {
        PlansService::new(
            Arc::new(self.store.publisher()),
            Arc::clone(&self.store.appender),
            Arc::clone(&self.store.reads),
        )
    }

    // A new session with a session row and no events.
    fn new_session(&self) -> SessionId {
        let session_id = test_session_id();
        insert_session_row(
            &self.store.database.reader(),
            session_id.text().as_str(),
            None,
            None,
        );
        session_id
    }

    // A session the last start left stale, holding `count` pinned events, its row at
    // `broken_at` no event, and a running run.
    async fn stale_session(&self, count: usize, broken_at: Option<i64>) -> (SessionId, RunId) {
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
        let run_id = new_run_id();
        insert_running_run(&self.store.database, session_id, run_id);
        (session_id, run_id)
    }

    // The payloads of every `event_type` event of `session_id`, in log order.
    fn payloads(&self, session_id: &SessionId, event_type: SessionEventType) -> Vec<Value> {
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

    // The newest sequence of `session_id`'s log.
    fn head(&self, session_id: &SessionId) -> i64 {
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

    // The state `table`'s row `id` holds.
    fn state(&self, table: &str, id: &str) -> String {
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

    // Records an intervention of `kind` on `run_id` in `state`, with its stored `record`.
    fn record_intervention(&self, run_id: RunId, kind: &str, state: &str, record: &str) -> String {
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

    fn record_pending_ask(&self, session_id: SessionId, run_id: RunId) -> String {
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

    async fn append(&self, session_id: SessionId, event: Value) {
        let event: SessionEvent = serde_json::from_value(event).expect("the test's event reads");
        crate::session::run::engine::tests::append(&self.engine, session_id, &event).await;
    }
}

fn new_run_id() -> RunId {
    RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id")
}

// The folders the store's files were copied aside into.
fn aside_copies(data_folder: &Path) -> Vec<PathBuf> {
    fs::read_dir(data_folder.join("damaged"))
        .map(|entries| {
            entries
                .map(|entry| entry.expect("a copy's entry reads").path())
                .collect()
        })
        .unwrap_or_default()
}

// One session holds two runs the restart left: one running with a pending ask and a faster-model
// retry sent and one not, and one ended with an open turn a token limit's accepted row cuts, a
// person's interrupt never sent, a pending ask, an open refusal choice and a held plan. Killed by
// the retries settled after their run (the accepted one reads `expired`); by step 4 before step 3
// (the turn ends `daemonRestart`); by any step left out; and by `mark_pass_ended` missing (a call
// naming no session is refused).
#[tokio::test]
async fn a_pass_settles_what_a_restart_left_in_a_session_in_order() {
    let fixture = PassFixture::new().await;
    let session_id = fixture.store.session_id;
    let ended_run = fixture.store.run_id;
    let plan_id = fixture
        .plans()
        .take_plan(ProviderPlan {
            session_id,
            run_id: ended_run,
            text: "# The plan\n\nBuild it.".to_owned(),
            plan_file_path: None,
            holds_request: true,
        })
        .await
        .expect("the plan is held");
    fixture
        .append(
            session_id,
            json!({
                "type": "agent.turn.started",
                "payload": {"sessionId": session_id, "runId": ended_run, "runVersion": 0,
                            "turnNumber": 1},
            }),
        )
        .await;
    fixture
        .append(
            session_id,
            json!({
                "type": "agent.run.refusalChoice.requested",
                "payload": {"sessionId": session_id, "runId": ended_run,
                            "refusedModel": "model-a", "fallbackModel": "model-b"},
            }),
        )
        .await;
    let token_cut = fixture.record_intervention(
        ended_run,
        "interrupt",
        "accepted",
        r#"{"limit":"tokenLimit","turnNumber":1}"#,
    );
    let unsent_interrupt = fixture.record_intervention(
        ended_run,
        "interrupt",
        "requested",
        r#"{"pending":"nextTurn"}"#,
    );
    let ended_ask = fixture.record_pending_ask(session_id, ended_run);
    fixture
        .store
        .database
        .reader()
        .execute(
            "UPDATE runs SET state = 'completed', run_version = 1 WHERE run_id = ?1",
            [ended_run.text().as_str()],
        )
        .expect("the run ended before the restart");
    let running_run = new_run_id();
    insert_running_run(&fixture.store.database, session_id, running_run);
    let running_ask = fixture.record_pending_ask(session_id, running_run);
    let sent_retry = fixture.record_intervention(running_run, "fasterModelRetry", "accepted", "{}");
    let unsent_retry =
        fixture.record_intervention(running_run, "fasterModelRetry", "requested", "{}");

    fixture
        .pass(Arc::clone(&fixture.status))
        .run(&CancellationToken::new())
        .await;

    let retry_reason: (String, Option<String>) = fixture
        .store
        .database
        .reader()
        .query_row(
            "SELECT state, failure_reason FROM interventions WHERE id = ?1",
            [sent_retry.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("the sent retry reads");
    assert_eq!(
        retry_reason,
        (
            "failed".to_owned(),
            Some(
                "The background service restarted before the retry's outcome was known".to_owned()
            )
        )
    );
    assert_eq!(fixture.state("interventions", &unsent_retry), "expired");
    let settled_ids = |event_type| -> Vec<Value> {
        fixture
            .payloads(&session_id, event_type)
            .into_iter()
            .map(|payload| payload["interventionId"].clone())
            .collect()
    };
    assert!(settled_ids(SessionEventType::AgentInterventionFailed).contains(&json!(sent_retry)));
    assert!(settled_ids(SessionEventType::AgentInterventionExpired).contains(&json!(unsent_retry)));
    assert_eq!(
        stored_run_state(&fixture.store.database, &running_run).0,
        "failed"
    );
    let failed = fixture.payloads(&session_id, SessionEventType::AgentRunFailed);
    assert_eq!(failed.len(), 1);
    assert_eq!(failed[0]["runId"], json!(running_run));
    assert_eq!(
        failed[0]["providerFailureDetail"],
        json!(RESTART_FAILURE_DETAIL)
    );
    assert_eq!(failed[0]["recoveryCondition"], json!("recoveryNeeded"));
    for ask in [&running_ask, &ended_ask] {
        assert_eq!(fixture.state("approval_requests", ask), "canceled");
    }
    assert_eq!(
        fixture
            .payloads(&session_id, SessionEventType::ApprovalCanceled)
            .len(),
        2
    );
    let turn_ends = fixture.payloads(&session_id, SessionEventType::AgentTurnInterrupted);
    assert_eq!(turn_ends.len(), 1);
    assert_eq!(turn_ends[0]["runId"], json!(ended_run));
    assert_eq!(turn_ends[0]["cause"], json!("tokenLimit"));
    assert_eq!(fixture.state("interventions", &unsent_interrupt), "expired");
    assert_ne!(fixture.state("interventions", &token_cut), "accepted");
    let choices = fixture.payloads(&session_id, SessionEventType::AgentRunRefusalChoiceResolved);
    assert_eq!(choices.len(), 1);
    assert!(
        choices[0].to_string().contains("\"runEnded\""),
        "{}",
        choices[0]
    );
    let hold_ends = fixture.payloads(&session_id, SessionEventType::PlanHoldEnded);
    assert_eq!(hold_ends.len(), 1);
    assert_eq!(hold_ends[0]["planId"], json!(plan_id));
    assert_eq!(hold_ends[0]["reason"], json!("runEnded"));
    assert_eq!(fixture.state("plans", &plan_id.to_string()), "open");
    let succeeded = fixture.payloads(
        &DAEMON_SCOPE_SENTINEL_SESSION_ID,
        SessionEventType::DaemonRecoverySucceeded,
    );
    assert_eq!(succeeded.len(), 1);
    assert_eq!(succeeded[0]["runsFailedDeterministically"], json!(1));
    assert_eq!(fixture.status.read_daemon_write_refusal(false), None);
    assert!(refuse_call_naming_session(&fixture.status, &session_id, "session.pin").is_ok());
}

// Two sessions with running runs, one stale with a broken row mid-log: it opens at the event
// before the row with no event appended, and alone refuses its writes; the other's run is
// settled, the pass records its failure, and the writer counts no live run. Killed by a pass that
// settles a damaged session (its head moves), and by the count's cursor clause deleted (reads 1).
#[tokio::test]
async fn a_session_whose_log_cannot_be_rebuilt_opens_at_its_last_good_point_alone() {
    let fixture = PassFixture::new().await;
    let (damaged, damaged_run) = fixture.stale_session(3, Some(1)).await;
    let healthy_run = fixture.store.run_id;

    fixture
        .pass(Arc::clone(&fixture.status))
        .run(&CancellationToken::new())
        .await;

    let point = fixture
        .status
        .read_last_good_point(&damaged)
        .expect("the damaged session opens at a point");
    assert_eq!(
        (point.last_sequence.get(), point.damaged_from_sequence.get()),
        (0, 1)
    );
    assert_eq!(fixture.head(&damaged), 2);
    assert_eq!(
        stored_run_state(&fixture.store.database, &damaged_run).0,
        "running"
    );
    assert_eq!(
        refuse_call_naming_session(&fixture.status, &damaged, "session.pin")
            .expect_err("the damaged session takes no write")
            .code,
        RefusalCode::SessionHistoryDamaged
    );
    assert_eq!(
        stored_run_state(&fixture.store.database, &healthy_run).0,
        "failed"
    );
    let failed = fixture.payloads(
        &DAEMON_SCOPE_SENTINEL_SESSION_ID,
        SessionEventType::DaemonRecoveryFailed,
    );
    assert_eq!(failed.len(), 1);
    assert_eq!(failed[0]["failureKind"], json!("projectionRebuildFailed"));
    assert_eq!(*fixture.live_runs.borrow(), 0);
}

// A stop while a stale session's rebuild waits on its log: the pass ends, its cursor is left
// rebuilding for the next start, the store is not read as failed and no failure is recorded.
// Killed by `Stopped` read as a store failure.
#[tokio::test]
async fn a_stop_during_a_rebuild_ends_the_pass_without_failing_the_store() {
    let fixture = PassFixture::new().await;
    let (stale, _run_id) = fixture.stale_session(2, None).await;
    let pass = Arc::new(fixture.pass(Arc::clone(&fixture.status)));
    let stop = CancellationToken::new();
    let held = SESSION_APPEND_LOCK.acquire(stale).await;
    let held_alone = SESSION_APPEND_LOCK.queue_handle_count(stale);
    let running = tokio::spawn({
        let pass = Arc::clone(&pass);
        let stop = stop.clone();
        async move { pass.run(&stop).await }
    });
    tokio::time::timeout(SETTLE_WAIT, async {
        while SESSION_APPEND_LOCK.queue_handle_count(stale) == held_alone {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the rebuild waits on the session's log");

    stop.cancel();
    drop(held);
    tokio::time::timeout(SETTLE_WAIT, running)
        .await
        .expect("the pass ends")
        .expect("the pass's task ends");

    assert_eq!(fixture.status.read_daemon_write_refusal(false), None);
    let cursor: String = fixture
        .store
        .database
        .reader()
        .query_row(
            "SELECT state FROM projection_cursors WHERE session_id = ?1",
            [stale.text().as_str()],
            |row| row.get(0),
        )
        .expect("the cursor reads");
    assert_eq!(cursor, "rebuilding");
    assert_eq!(
        fixture.payloads(
            &DAEMON_SCOPE_SENTINEL_SESSION_ID,
            SessionEventType::DaemonRecoveryFailed
        ),
        Vec::<Value>::new()
    );
}

// While a stale session's rebuild waits, and again while its run's settle waits, only that
// session refuses the calls naming it; a call naming no session waits for the pass's end. Killed
// by `mark_pass_listed` after the rebuilds, and by a listed session marked healthy before its
// settle.
#[tokio::test]
async fn a_session_the_pass_rebuilds_refuses_its_calls_alone_until_settled() {
    let fixture = PassFixture::new().await;
    let other = fixture.new_session();
    fixture
        .store
        .database
        .reader()
        .execute(
            "UPDATE runs SET state = 'completed' WHERE run_id = ?1",
            [fixture.store.run_id.text().as_str()],
        )
        .expect("the seeded run ended");
    let (stale, stale_run) = fixture.stale_session(2, None).await;
    let pass = Arc::new(fixture.pass(Arc::clone(&fixture.status)));
    let held = SESSION_APPEND_LOCK.acquire(stale).await;
    let held_alone = SESSION_APPEND_LOCK.queue_handle_count(stale);
    let settle_paused = fixture.engine.restart_facts_pause.arm();
    let running = tokio::spawn({
        let pass = Arc::clone(&pass);
        async move { pass.run(&CancellationToken::new()).await }
    });
    tokio::time::timeout(SETTLE_WAIT, async {
        while SESSION_APPEND_LOCK.queue_handle_count(stale) == held_alone {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the rebuild waits on the session's log");
    let status = &fixture.status;
    let refusal_of = |session_id: &SessionId| {
        refuse_call_naming_session(status, session_id, "session.pin")
            .err()
            .map(|refusal| refusal.code)
    };
    assert_eq!(status.read_daemon_write_refusal(true), None);
    assert_eq!(refusal_of(&other), None);
    assert_eq!(refusal_of(&stale), Some(RefusalCode::SessionRebuilding));
    assert!(status.read_daemon_write_refusal(false).is_some());

    drop(held);
    tokio::time::timeout(SETTLE_WAIT, settle_paused.reached)
        .await
        .expect("the stale session's run is settled")
        .expect("the pause reports");
    assert_eq!(refusal_of(&stale), Some(RefusalCode::SessionRebuilding));
    assert!(refuse_session_event(status, &stale, "agent.run.failed").is_ok());
    settle_paused
        .release
        .send(())
        .expect("the settle is let go");
    tokio::time::timeout(SETTLE_WAIT, running)
        .await
        .expect("the pass ends")
        .expect("the pass's task ends");

    assert_eq!(status.read_daemon_write_refusal(false), None);
    assert_eq!(refusal_of(&other), None);
    assert_eq!(refusal_of(&stale), None);
    assert_eq!(
        stored_run_state(&fixture.store.database, &stale_run).0,
        "failed"
    );
}

// Two sessions whose rebuilds fail twice are copied aside in one copy, and the next start over
// the same damage takes none. Killed by `find_aside_copy_of_session` skipped, and by a copy per
// session.
#[tokio::test]
async fn the_store_is_copied_aside_once_for_one_damage() {
    let fixture = PassFixture::new().await;
    let (first, _) = fixture.stale_session(2, Some(1)).await;
    let (second, _) = fixture.stale_session(2, Some(0)).await;

    fixture
        .pass(Arc::clone(&fixture.status))
        .run(&CancellationToken::new())
        .await;
    let copies = aside_copies(fixture.data_folder.path());
    assert_eq!(copies.len(), 1, "{copies:?}");
    assert_eq!(fixture.status.read_damaged_from_sequence(&first), Some(1));
    assert_eq!(
        fixture.status.read_damaged_from_sequence(&second),
        Some(START_OF_LOG_POSITION)
    );

    let next_start = Arc::new(RecoveryStatusTracker::new());
    fixture
        .pass(Arc::clone(&next_start))
        .run(&CancellationToken::new())
        .await;

    assert_eq!(aside_copies(fixture.data_folder.path()), copies);
    assert!(next_start.read_session_write_refusal(&first).is_some());
    assert!(next_start.read_session_write_refusal(&second).is_some());
}
