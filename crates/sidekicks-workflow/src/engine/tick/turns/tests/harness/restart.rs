//! One daemon life's loop over the harness's database, and the restart that ends the running
//! life and takes the unfinished runs back in a new one, as the daemon's start does.

use std::path::PathBuf;
use std::sync::Arc;

use sidekicks_std::scheduler::Scheduler;
use sidekicks_std::scheduler::test_wall_clock::TestWallClock;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::events::log_service::test_fixture::TestLog;
use sidekicks_workspace::run_setup_gates::execution_root::context::SessionRunBinder;
use tokio::sync::{mpsc, watch};

use super::Harness;
use super::ports::{RecordingAsks, RecordingSnapshotPoints};
use crate::definitions::kept_values::{
    WORKFLOW_KEPT_VALUE_STORE_STATEMENT_CAPACITY, WorkflowKeptValueStore,
};
use crate::engine::deadlines::{ENGINE_DEADLINE_STATEMENT_CAPACITY, EngineDeadlines};
use crate::engine::event_record::EngineRecorder;
use crate::engine::ports::kept_payloads::KeptPayloads;
use crate::engine::ports::noticed_sessions::NoticedSessions;
use crate::engine::ports::run_limits::ScriptedRunLimits;
use crate::engine::ports::scripted_agent_runs::ScriptedAgentRunner;
use crate::engine::ports::{
    AgentStepRunner, ApprovalCardRaiser, EnginePorts, PersonWaitQuestions, RunSnapshotPoints,
    ScriptedGate, StepAdmission, StepAdmissionOutcome, StepPayloadArtifacts, WorkflowRunLimits,
    refusing_engine_ports,
};
use crate::engine::start::reload::RunReloader;
use crate::engine::tick::StepReport;
use crate::engine::tick::dispatch::test_dispatch_recording;
use crate::engine::tick::turns::{
    ENGINE_TICK_STATEMENT_CAPACITY, EngineTick, EngineTickDependencies, EngineTickInput,
};
use crate::engine::waits::PersonWaitPorts;
use crate::kinds::NodeKindTable;

/// What every daemon life of a test shares: the database, its log, the kinds, the record, the
/// payload store, the asks, the points, the binder's notices, the wall clock and the run limits.
pub(super) struct LifeParts<'harness> {
    pub(super) database: &'harness TestDatabase,
    pub(super) log: &'harness TestLog,
    pub(super) kinds: &'harness Arc<NodeKindTable>,
    pub(super) recorder: &'harness Arc<EngineRecorder>,
    pub(super) payloads: &'harness Arc<KeptPayloads>,
    pub(super) asks: &'harness Arc<RecordingAsks>,
    pub(super) points: &'harness Arc<RecordingSnapshotPoints>,
    pub(super) notices: &'harness Arc<NoticedSessions>,
    pub(super) clock: &'harness Arc<TestWallClock>,
    pub(super) limits: &'harness Arc<ScriptedRunLimits>,
}

/// One daemon life's loop, not yet running, with its inbox, a sending end of its report channel,
/// its deadline clock and its agent runner, every run admitted at once.
pub(super) struct DaemonLife {
    pub(super) tick: EngineTick,
    pub(super) inbox: mpsc::Sender<EngineTickInput>,
    pub(super) reports: mpsc::Sender<StepReport>,
    pub(super) deadlines: Arc<EngineDeadlines>,
    pub(super) agents: Arc<ScriptedAgentRunner>,
}

impl DaemonLife {
    /// A new life's loop over `parts`, its own memory gate, agent runner, dispatch and clock.
    pub(super) fn start(parts: &LifeParts<'_>) -> Self {
        let LifeParts {
            database,
            log,
            kinds,
            recorder,
            payloads,
            asks,
            points,
            notices,
            clock,
            limits,
        } = *parts;
        let gate = Arc::new(ScriptedGate::new(None));
        let agents = Arc::new(ScriptedAgentRunner::new(
            Some(StepAdmissionOutcome::Admitted),
            false,
        ));
        let ports = EnginePorts {
            admission: Arc::clone(&gate) as Arc<dyn StepAdmission>,
            agent_steps: Arc::clone(&agents) as Arc<dyn AgentStepRunner>,
            payloads: Arc::clone(payloads) as Arc<dyn StepPayloadArtifacts>,
            ..refusing_engine_ports()
        };
        let (dispatch, received_reports, reports) =
            test_dispatch_recording(database, ports, Arc::clone(kinds), Arc::clone(recorder));
        let wall_clock: Arc<TestWallClock> = Arc::clone(clock);
        let scheduler = Arc::new(Scheduler::start(wall_clock, None, watch::channel(0).1));
        let deadlines = EngineDeadlines::new(
            scheduler,
            Arc::new(DatabaseReadPool::new(
                database.path(),
                ENGINE_DEADLINE_STATEMENT_CAPACITY,
            )),
            reports.clone(),
            Arc::clone(limits) as Arc<dyn WorkflowRunLimits>,
        );
        let (inbox, received) = mpsc::channel(4);
        let tick = EngineTick::new(EngineTickDependencies {
            dispatch,
            event_log: Arc::clone(&log.service),
            pool: Arc::new(DatabaseReadPool::new(
                database.path(),
                ENGINE_TICK_STATEMENT_CAPACITY,
            )),
            kinds: Arc::clone(kinds),
            recorder: Arc::clone(recorder),
            payloads: Arc::clone(payloads) as Arc<dyn StepPayloadArtifacts>,
            admission: gate,
            reports: received_reports,
            inbox: received,
            person_waits: PersonWaitPorts {
                cards: Arc::clone(asks) as Arc<dyn ApprovalCardRaiser>,
                questions: Arc::clone(asks) as Arc<dyn PersonWaitQuestions>,
            },
            deadlines: Arc::clone(&deadlines),
            snapshot_points: Arc::clone(points) as Arc<dyn RunSnapshotPoints>,
            binder: Arc::clone(notices) as Arc<dyn SessionRunBinder>,
        });
        Self {
            tick,
            inbox,
            reports,
            deadlines,
            agents,
        }
    }
}

impl Harness {
    /// Stops the running loop as the daemon's stop does, its steps cut off unsettled, then
    /// reloads the scope's session's unfinished runs and starts a new life's loop on them.
    pub(in crate::engine::tick::turns) async fn restart(&mut self) {
        let DaemonLife {
            mut tick,
            inbox,
            reports,
            deadlines,
            agents,
        } = DaemonLife::start(&LifeParts {
            database: &self.database,
            log: &self.log,
            kinds: &self.kinds,
            recorder: &self.recorder,
            payloads: &self.payloads,
            asks: &self.asks,
            points: &self.points,
            notices: &self.notices,
            clock: &self.clock,
            limits: &self.limits,
        });
        // The old loop ends once its inbox closes.
        self.inbox = inbox;
        let old_task = std::mem::replace(&mut self.tick_task, tokio::spawn(async {}));
        old_task.await.expect("the old loop ends");
        let session_id = self.scope.session_id;
        let is_stored: bool = self
            .rows
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM sessions WHERE id = ?1)",
                [session_id.text().as_str()],
                |row| row.get(0),
            )
            .expect("the test reads its session");
        if !is_stored {
            insert_session_row(&self.rows, session_id.text().as_str(), None, None);
        }
        let pool = Arc::new(DatabaseReadPool::new(
            self.database.path(),
            ENGINE_TICK_STATEMENT_CAPACITY + WORKFLOW_KEPT_VALUE_STORE_STATEMENT_CAPACITY,
        ));
        let reloader = RunReloader {
            pool: Arc::clone(&pool),
            kinds: Arc::clone(&self.kinds),
            kept_values: Arc::new(WorkflowKeptValueStore::new(
                pool,
                Arc::clone(&self.log.writer),
                Arc::clone(&self.payloads) as Arc<dyn StepPayloadArtifacts>,
            )),
            data_folder: PathBuf::from("/data"),
            binder: Arc::clone(&self.notices) as Arc<dyn SessionRunBinder>,
            payloads: Arc::clone(&self.payloads) as Arc<dyn StepPayloadArtifacts>,
        };
        let runs = reloader
            .reload_session(session_id)
            .await
            .expect("the session's runs reload");
        tick.restart(runs).await;
        self.tick_task = tokio::spawn(tick.run());
        self.reports = reports;
        self.deadlines = deadlines;
        self.agents = agents;
    }
}
