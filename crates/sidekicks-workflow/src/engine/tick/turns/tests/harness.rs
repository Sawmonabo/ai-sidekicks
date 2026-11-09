//! The tick loop's test harness: a loop over a test database, the kinds its tests run, and
//! what the tests read back.

pub(in crate::engine::tick::turns) mod ports;

use std::sync::Arc;
use std::time::{Duration, SystemTime};

use futures::future::BoxFuture;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::AnyValue;
use sidekicks_contracts::wire::id::UuidTextForm;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::{ComposedText, NonEmptyText};
use sidekicks_contracts::workflow::definition::document::{WorkflowEdge, WorkflowNode};
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::run::control::WorkflowCancelReason;
use sidekicks_contracts::workflow::run::events::WorkflowRunStartedPayload;
use sidekicks_contracts::workflow::run::trigger::{
    WorkflowRunChainPlace, WorkflowRunMode, WorkflowRunTrigger, WorkflowStartedBy,
    WorkflowTriggerKind,
};
use sidekicks_std::scheduler::Scheduler;
use sidekicks_std::scheduler::armed_instant::InstantJob as _;
use sidekicks_std::scheduler::test_wall_clock::TestWallClock;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log};
use sidekicks_store::events::session::appender::{
    SessionEventAppender, SessionEventDraft, SessionEventLinkage,
};
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;
use sidekicks_workspace::run_setup_gates::execution_root::context::SessionRunBinder;
use tokio::sync::oneshot::error::RecvError;
use tokio::sync::{Notify, mpsc, oneshot, watch};
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use crate::engine::chain::{KeepGoingAnswer, KeepGoingIntake};
use crate::engine::deadlines::{ENGINE_DEADLINE_STATEMENT_CAPACITY, EngineDeadlines};
use crate::engine::event_record::EngineRecorder;
use crate::engine::ports::kept_payloads::KeptPayloads;
use crate::engine::ports::noticed_sessions::NoticedSessions;
use crate::engine::ports::run_limits::ScriptedRunLimits;
use crate::engine::ports::scripted_agent_runs::ScriptedAgentRunner;
use crate::engine::ports::{
    AgentStepRequest, AgentStepRunner, ApprovalCardRaiser, EnginePorts, EngineRecordSink,
    KeptEngineRecords, PersonWaitQuestions, RunSnapshotPoints, ScriptedGate, StepAdmission,
    StepAdmissionOutcome, StepPayloadArtifacts, WorkflowRunLimits, refusing_engine_ports,
};
use crate::engine::start::StartedRun;
use crate::engine::tick::commit::SessionEventId;
use crate::engine::tick::dispatch::test_dispatch_recording;
use crate::engine::tick::turns::ending::RunCancelRefusal;
use crate::engine::tick::turns::tests::harness::ports::{
    OrderLog, OrderedCall, RecordingAsks, RecordingSnapshotPoints,
};
use crate::engine::tick::turns::{
    ENGINE_TICK_STATEMENT_CAPACITY, EngineTick, EngineTickDependencies, EngineTickInput,
    RunCancelIntake,
};
use crate::engine::tick::{RunGraph, RunScope, StepReport, test_run_scope};
use crate::engine::waits::answers::PersonWaitIntake;
use crate::engine::waits::{PersonWaitAnswer, PersonWaitPorts, PersonWaitRefusal};
use crate::kinds::step_context::StepContext;
use crate::kinds::{
    NodeExecutor, NodeKindTable, PassThroughExecutor, PersonAsk, PersonWait, StepAdmissionNeed,
    StepFailure, StepOutcome, test_kind, uncoded_step_error,
};
use crate::runs::creation::{
    WorkflowRunCreation, trigger_step_key, workflow_run_creation_statements,
};
use crate::runs::gate_resolution::WorkflowGateAnswer;
use crate::runs::step_payload::write_step_payload;
use crate::schema::schema_parts;
use crate::test_rows::insert_workflow_version_body;

/// How long a test waits for what the loop must write.
pub(in crate::engine::tick::turns) const WAIT: Duration = Duration::from_secs(10);
/// A wait id no step ever waits under, which the turn barrier answers.
const NO_WAIT_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4eff";
/// How long a test waits to see that the loop writes nothing more.
pub(in crate::engine::tick::turns) const QUIET: Duration = Duration::from_millis(300);

/// A test executor's behavior, by the node it runs.
#[derive(Clone, Copy)]
enum Script {
    /// Fails its first try uncoded, then outputs one item.
    Flaky,
    /// Wakes the test once it runs, waits for its cancel, wakes the test, waits for the test's
    /// release, then passes its inputs on.
    Linger,
    /// Waits for the test's go, then passes its inputs on.
    Gated,
    /// Waits for the test's go, then fails uncoded.
    GatedFailure,
    /// Waits for the test's go, then fails uncoded in a way that ends its run.
    GatedStop,
    /// Passes its inputs on, readied on its first main input with items.
    First,
    /// Outputs one empty list.
    Empty,
    /// Waits for the test's release, then outputs ten items of 7 KiB, above the inline cap
    /// together.
    Large,
    /// Waits for its cancel, then passes its inputs on.
    AwaitCancel,
    /// Outputs the level it runs at; the node `A` first waits for the test's release.
    Level,
    /// Asks an approval that times out after 60 s.
    Approve,
    /// Asks for a chat reply that times out after 120 s.
    Ask,
    /// Asks for a form that times out after 120 s.
    Form,
    /// Asks for an agent run, which the harness's runner makes.
    Agent,
    /// Keeps the run variable `report`, above the inline cap, for later runs, then passes its
    /// inputs on.
    Keep,
}

/// An executor that runs `script`, waking `signal` where the script waits or is canceled.
struct ScriptedExecutor {
    script: Script,
    signal: Arc<Signals>,
}

/// What the test and its executors wake each other with.
#[derive(Default)]
pub(in crate::engine::tick::turns) struct Signals {
    /// Woken when a step starts waiting for its release or is canceled.
    pub(in crate::engine::tick::turns) reached: Notify,
    /// Woken by the test to release a waiting step.
    pub(in crate::engine::tick::turns) release: Notify,
    /// Woken when a lingering step runs, so the test lets a cancel land only on a running step.
    pub(in crate::engine::tick::turns) running: Notify,
    /// Woken by the test to let a gated step settle.
    pub(in crate::engine::tick::turns) go: Notify,
}

impl NodeExecutor for ScriptedExecutor {
    fn execute<'step>(
        &'step self,
        context: &'step StepContext,
        inputs: Vec<Vec<WorkflowItem>>,
    ) -> BoxFuture<'step, Result<StepOutcome, StepFailure>> {
        Box::pin(async move {
            Ok(StepOutcome::Outputs(match self.script {
                Script::Flaky => {
                    if context.step.attempt.get() == 1 {
                        return Err(StepFailure::Failed(Box::new(uncoded_step_error(
                            "the first try fails".to_owned(),
                        ))));
                    }
                    vec![vec![item(json!({ "attempt": context.step.attempt }))]]
                }
                Script::Linger => {
                    self.signal.running.notify_one();
                    context.cancel.cancelled().await;
                    self.signal.reached.notify_one();
                    self.signal.release.notified().await;
                    inputs
                }
                Script::First => inputs,
                Script::Gated => {
                    self.signal.go.notified().await;
                    inputs
                }
                Script::GatedFailure => {
                    self.signal.go.notified().await;
                    return Err(StepFailure::Failed(Box::new(uncoded_step_error(
                        "the gated step fails".to_owned(),
                    ))));
                }
                Script::GatedStop => {
                    self.signal.go.notified().await;
                    return Err(StepFailure::EndsRun(Box::new(uncoded_step_error(
                        "the gated step stops its run".to_owned(),
                    ))));
                }
                Script::Empty => vec![Vec::new()],
                Script::Keep => {
                    let report = json!("y".repeat(70 * 1024));
                    context.set_run_variables(
                        serde_json::Map::from_iter([("report".to_owned(), report)]),
                        true,
                    );
                    inputs
                }
                Script::Large => {
                    self.signal.release.notified().await;
                    vec![large_items()]
                }
                Script::AwaitCancel => {
                    context.cancel.cancelled().await;
                    self.signal.reached.notify_one();
                    inputs
                }
                Script::Level => {
                    if context.step.node_id.as_str() == "A" {
                        self.signal.reached.notify_one();
                        self.signal.release.notified().await;
                    }
                    let level = serde_json::to_value(context.permission_level)
                        .expect("a level writes as JSON");
                    vec![vec![item(json!({ "level": level }))]]
                }
                Script::Approve => {
                    return Ok(person_wait(PersonAsk::Approval { prompt: prompt() }, 60));
                }
                Script::Ask => return Ok(person_wait(PersonAsk::Reply { prompt: prompt() }, 120)),
                Script::Agent => {
                    return Ok(StepOutcome::AgentRun(AgentStepRequest {
                        session_id: context.session_id,
                        step: context.step.clone(),
                        node_key: context.node_key.clone(),
                        permission_level: context.permission_level,
                        params: serde_json::Map::new(),
                    }));
                }
                Script::Form => {
                    let input_schema = serde_json::Map::new();
                    let form = PersonAsk::Form {
                        prompt: prompt(),
                        input_schema,
                    };
                    return Ok(person_wait(form, 120));
                }
            }))
        })
    }

    fn readies_on_first_input(&self, _node: &WorkflowNode) -> bool {
        matches!(self.script, Script::First)
    }

    fn admission_need(&self, _node: &WorkflowNode) -> StepAdmissionNeed {
        if matches!(self.script, Script::Agent) {
            StepAdmissionNeed::OwnRun
        } else {
            StepAdmissionNeed::Unweighed
        }
    }
}

pub(in crate::engine::tick::turns) fn item(json: Value) -> WorkflowItem {
    WorkflowItem {
        json: AnyValue(json),
        binary: None,
        paired_item: None,
        error: None,
    }
}

/// A wait on a person asking `ask`, which times out after `timeout_secs`.
fn person_wait(ask: PersonAsk, timeout_secs: u64) -> StepOutcome {
    StepOutcome::PersonWait(PersonWait {
        ask,
        timeout: Some(Duration::from_secs(timeout_secs)),
    })
}

/// What the test's person waits ask.
fn prompt() -> ComposedText {
    ComposedText::new("Ship it?".to_owned()).expect("the test's prompt")
}

/// Ten items of 7 KiB each, above the inline cap together.
pub(in crate::engine::tick::turns) fn large_items() -> Vec<WorkflowItem> {
    (0..10)
        .map(|index| item(json!({ "index": index, "text": "x".repeat(7 * 1024) })))
        .collect()
}

/// A kind `kind` with `input_count` main inputs and `output_count` main outputs, run by
/// `executor`.
fn kind(
    kind: &str,
    category: &str,
    (input_count, output_count): (usize, usize),
    executor: Box<dyn NodeExecutor>,
) -> crate::kinds::NodeKind {
    let inputs: Vec<Value> = (0..input_count)
        .map(|index| json!({ "type": "main", "id": format!("inputs/main/{index}"), "label": "In" }))
        .collect();
    let outputs: Vec<Value> = (0..output_count)
        .map(|index| {
            json!({ "type": "main", "id": format!("outputs/main/{index}"), "label": "Out" })
        })
        .collect();
    test_kind(
        json!({
            "kind": kind, "version": 1, "category": category, "displayName": kind,
            "description": "A test kind.", "icon": "test", "params": [],
            "outputsDeriveFromParams": false, "inputs": inputs,
            "outputs": outputs,
        }),
        None,
        executor,
    )
}

/// The test's kinds: a trigger and a step passing their inputs on, and one kind per script; an
/// approval has two outputs, which its answer fills.
fn kinds(signal: &Arc<Signals>) -> Arc<NodeKindTable> {
    let scripted = |name: &str, inputs: usize, script: Script| {
        let outputs = if matches!(script, Script::Approve) {
            2
        } else {
            1
        };
        kind(
            name,
            "developer",
            (inputs, outputs),
            Box::new(ScriptedExecutor {
                script,
                signal: Arc::clone(signal),
            }),
        )
    };
    Arc::new(
        NodeKindTable::new(vec![
            kind(
                "test.trigger",
                "trigger",
                (1, 1),
                Box::new(PassThroughExecutor),
            ),
            kind(
                "test.step",
                "developer",
                (1, 1),
                Box::new(PassThroughExecutor),
            ),
            kind(
                "test.pair",
                "developer",
                (2, 1),
                Box::new(PassThroughExecutor),
            ),
            scripted("test.empty", 1, Script::Empty),
            scripted("test.large", 1, Script::Large),
            scripted("test.wait", 1, Script::AwaitCancel),
            scripted("test.level", 1, Script::Level),
            scripted("test.flaky", 1, Script::Flaky),
            scripted("test.linger", 1, Script::Linger),
            scripted("test.first", 2, Script::First),
            scripted("test.gated", 1, Script::Gated),
            scripted("test.gatedFailure", 1, Script::GatedFailure),
            scripted("test.gatedStop", 1, Script::GatedStop),
            scripted("test.approve", 1, Script::Approve),
            scripted("test.ask", 1, Script::Ask),
            scripted("test.form", 1, Script::Form),
            scripted("test.agent", 1, Script::Agent),
            scripted("test.keep", 1, Script::Keep),
        ])
        .expect("the test's kinds build a table"),
    )
}

pub(in crate::engine::tick::turns) fn node(
    id: &str,
    kind: &str,
    order: i64,
    on_error: Option<&str>,
) -> WorkflowNode {
    let mut node = json!({
        "id": id, "kind": kind, "kindVersion": 1, "name": id, "order": order, "params": {},
    });
    if let Some(on_error) = on_error {
        node["onError"] = json!(on_error);
    }
    serde_json::from_value(node).expect("the test's node reads")
}

/// `node` retried up to `max_tries` tries, `wait_ms` apart.
pub(in crate::engine::tick::turns) fn retried(
    mut node: WorkflowNode,
    max_tries: u64,
    wait_ms: u64,
) -> WorkflowNode {
    node.retry = Some(
        serde_json::from_value(json!({ "maxTries": max_tries, "waitMs": wait_ms }))
            .expect("the test's retry reads"),
    );
    node
}

pub(in crate::engine::tick::turns) fn edge(
    source: &str,
    target: &str,
    input: usize,
) -> WorkflowEdge {
    serde_json::from_value(json!({
        "id": format!("{source}-{target}-{input}"),
        "source": source, "sourceHandle": "outputs/main/0",
        "target": target, "targetHandle": format!("inputs/main/{input}"),
    }))
    .expect("the test's edge reads")
}

/// The receiving end of the loop's reply to a person's cancel.
pub(in crate::engine::tick::turns) type CancelReplied =
    oneshot::Receiver<Result<SessionEventId, RunCancelRefusal>>;

/// The loop over a test database, its payload store and record kept for the test, with the
/// inbox runs start through.
pub(in crate::engine::tick::turns) struct Harness {
    database: TestDatabase,
    pub(in crate::engine::tick::turns) rows: Connection,
    appender: SessionEventAppender,
    pub(in crate::engine::tick::turns) payloads: Arc<KeptPayloads>,
    pub(in crate::engine::tick::turns) records: Arc<KeptEngineRecords>,
    /// The loop's recorder, which forgets a run's sequence once the run leaves the live set.
    pub(in crate::engine::tick::turns) recorder: Arc<EngineRecorder>,
    kinds: Arc<NodeKindTable>,
    pub(in crate::engine::tick::turns) signal: Arc<Signals>,
    changes: watch::Receiver<u64>,
    /// The loop's inbox, which a test sends on ahead of a start as a racing caller would.
    pub(in crate::engine::tick::turns) inbox: mpsc::Sender<EngineTickInput>,
    pub(in crate::engine::tick::turns) scope: RunScope,
    /// The asks the loop's waits go through.
    pub(in crate::engine::tick::turns) asks: Arc<RecordingAsks>,
    /// The snapshot points the loop's runs take.
    pub(in crate::engine::tick::turns) points: Arc<RecordingSnapshotPoints>,
    /// The asks' and the points' calls, in order.
    order: Arc<OrderLog>,
    /// The wall clock the deadline clock's scheduler runs on, set to the real clock at the start.
    pub(in crate::engine::tick::turns) clock: Arc<TestWallClock>,
    /// The loop's deadline clock.
    pub(in crate::engine::tick::turns) deadlines: Arc<EngineDeadlines>,
    /// The runner of the loop's agent steps, every run admitted at once.
    pub(in crate::engine::tick::turns) agents: Arc<ScriptedAgentRunner>,
    /// The run limits the deadline clock reads, none set until the test sets one.
    pub(in crate::engine::tick::turns) limits: Arc<ScriptedRunLimits>,
    /// A sending end of the loop's report channel, which the test reports on as a driver would.
    pub(in crate::engine::tick::turns) reports: mpsc::Sender<StepReport>,
    /// The sessions the loop told its binder of, once per run ending.
    pub(in crate::engine::tick::turns) notices: Arc<NoticedSessions>,
}

impl Harness {
    /// The loop running, its payload store keeping `write_limit` writes where one is given.
    pub(in crate::engine::tick::turns) async fn new(write_limit: Option<usize>) -> Self {
        let database = TestDatabase::new(schema_parts());
        let TestLog {
            service, followers, ..
        } = open_log(&database, None).await;
        let scope = test_run_scope(WorkflowRunMode::Manual, Vec::new());
        let changes = followers.change_count(&scope.session_id);
        let payloads = Arc::new(KeptPayloads::default());
        if let Some(write_limit) = write_limit {
            payloads.refuse_writes_past(write_limit);
        }
        let records = Arc::new(KeptEngineRecords::default());
        let recorder = Arc::new(EngineRecorder::new(
            Arc::clone(&records) as Arc<dyn EngineRecordSink>
        ));
        let signal = Arc::new(Signals::default());
        let kinds = kinds(&signal);
        let gate = Arc::new(ScriptedGate::new(None));
        let agents = Arc::new(ScriptedAgentRunner::new(
            Some(StepAdmissionOutcome::Admitted),
            false,
        ));
        let ports = EnginePorts {
            admission: Arc::clone(&gate) as Arc<dyn StepAdmission>,
            agent_steps: Arc::clone(&agents) as Arc<dyn AgentStepRunner>,
            payloads: Arc::clone(&payloads) as Arc<dyn StepPayloadArtifacts>,
            ..refusing_engine_ports()
        };
        let limits = Arc::new(ScriptedRunLimits::default());
        let (dispatch, received_reports, reports) =
            test_dispatch_recording(&database, ports, Arc::clone(&kinds), Arc::clone(&recorder));
        // The stored deadlines are real instants, so the test clock starts at the real clock.
        let clock = Arc::new(TestWallClock::default());
        clock.set_now(SystemTime::now());
        let wall_clock: Arc<TestWallClock> = Arc::clone(&clock);
        let scheduler = Arc::new(Scheduler::start(wall_clock, None, watch::channel(0).1));
        let deadlines = EngineDeadlines::new(
            scheduler,
            Arc::new(DatabaseReadPool::new(
                database.path(),
                ENGINE_DEADLINE_STATEMENT_CAPACITY,
            )),
            reports.clone(),
            Arc::clone(&limits) as Arc<dyn WorkflowRunLimits>,
        );
        let order = Arc::new(OrderLog::new(Vec::new()));
        let asks = Arc::new(RecordingAsks::new(database.reader(), Arc::clone(&order)));
        let points = Arc::new(RecordingSnapshotPoints::new(Arc::clone(&order)));
        let (inbox, received) = mpsc::channel(4);
        let notices = Arc::new(NoticedSessions::default());
        let tick = EngineTick::new(EngineTickDependencies {
            dispatch,
            event_log: Arc::clone(&service),
            pool: Arc::new(DatabaseReadPool::new(
                database.path(),
                ENGINE_TICK_STATEMENT_CAPACITY,
            )),
            kinds: Arc::clone(&kinds),
            recorder: Arc::clone(&recorder),
            payloads: Arc::clone(&payloads) as Arc<dyn StepPayloadArtifacts>,
            admission: gate,
            reports: received_reports,
            inbox: received,
            person_waits: PersonWaitPorts {
                cards: Arc::clone(&asks) as Arc<dyn ApprovalCardRaiser>,
                questions: Arc::clone(&asks) as Arc<dyn PersonWaitQuestions>,
            },
            deadlines: Arc::clone(&deadlines),
            snapshot_points: Arc::clone(&points) as Arc<dyn RunSnapshotPoints>,
            binder: Arc::clone(&notices) as Arc<dyn SessionRunBinder>,
        });
        tokio::spawn(tick.run());
        Self {
            rows: database.reader(),
            database,
            appender: SessionEventAppender::new(service, SESSION_EVENT_VERSION.clone()),
            payloads,
            records,
            recorder,
            kinds,
            signal,
            changes,
            inbox,
            scope,
            asks,
            points,
            order,
            clock,
            deadlines,
            agents,
            limits,
            reports,
            notices,
        }
    }

    /// Stores the workflow of `nodes` and `edges`, the node `trigger` its trigger, unless an
    /// earlier run stored it, and writes the run of the scope's run id and mode as the start does,
    /// on `trigger_items`; `before_start` runs once the run is stored and before the loop takes it.
    /// Answers the run's cancel.
    pub(in crate::engine::tick::turns) async fn start(
        &self,
        nodes: Vec<WorkflowNode>,
        edges: &[WorkflowEdge],
        trigger_items: Vec<WorkflowItem>,
        before_start: impl FnOnce(&Connection),
    ) -> CancellationToken {
        let base = &self.scope;
        let is_stored: bool = self
            .rows
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM workflow_definitions WHERE id = ?1)",
                [base.workflow_id.text().as_str()],
                |row| row.get(0),
            )
            .expect("the test reads its workflow");
        if !is_stored {
            insert_workflow_version_body(
                &self.rows,
                base.workflow_id.text().as_str(),
                base.workflow_version_id.text().as_str(),
                &json!({ "name": "Loop", "nodes": nodes, "edges": edges }),
            );
        }
        let trigger = WorkflowRunTrigger {
            kind: WorkflowTriggerKind::Manual,
            node_id: nodes[0].id.clone(),
        };
        let started_at = WireInstant::now();
        let run_started_at = started_at.timestamp().expect("a stored instant reads");
        let trigger_input = write_step_payload(
            self.payloads.as_ref(),
            base.session_id,
            &trigger_step_key(base.run_id, &trigger),
            &trigger_items,
        )
        .await
        .expect("the trigger's input is stored");
        let started_by = match base.mode {
            WorkflowRunMode::Manual => WorkflowStartedBy::User {
                device_id: DeviceId::new("device-1".to_owned()).expect("a device id"),
            },
            WorkflowRunMode::Chat => WorkflowStartedBy::Chat {
                session_id: base.session_id,
                message_anchor_cursor: None,
            },
            WorkflowRunMode::Trigger
            | WorkflowRunMode::Webhook
            | WorkflowRunMode::Agent
            | WorkflowRunMode::Retry
            | WorkflowRunMode::SubWorkflow => panic!("the harness starts manual and chat runs"),
        };
        let creation = WorkflowRunCreation {
            workflow_run_id: base.run_id,
            workflow_version_id: base.workflow_version_id,
            session_id: base.session_id,
            mode: base.mode,
            trigger: trigger.clone(),
            started_by: started_by.clone(),
            chain: WorkflowRunChainPlace::Starts {},
            execution_context: None,
            provider: None,
            started_at: started_at.clone(),
            trigger_input: Some(trigger_input.clone()),
            node_run: None,
        };
        let draft = SessionEventDraft::of_session(
            base.session_id,
            &SessionEvent::WorkflowRunStarted(WorkflowRunStartedPayload {
                session_id: base.session_id,
                workflow_run_id: base.run_id,
                definition_id: base.workflow_id,
                workflow_version_id: base.workflow_version_id,
                mode: base.mode,
                started_by,
                trigger: trigger.clone(),
                chain: WorkflowRunChainPlace::Starts {},
                provider: None,
                node_run: None,
                input_ref: Some(trigger_input.clone()),
            }),
        )
        .expect("the started event drafts");
        let receipt = self
            .appender
            .append(
                draft,
                SessionEventLinkage {
                    occurred_at: Some(started_at),
                    transactional_prelude: workflow_run_creation_statements(&creation, None),
                    ..SessionEventLinkage::default()
                },
            )
            .await
            .expect("the run is stored");
        before_start(&self.rows);
        let graph = RunGraph::new(
            &nodes
                .iter()
                .map(|node| (node.id.clone(), node.clone()))
                .collect(),
            &trigger.node_id,
            edges,
            &self.kinds,
        )
        .expect("the test's graph builds");
        let scope = RunScope {
            run_id: base.run_id,
            trigger,
            run_started_at,
            ..test_run_scope(base.mode, nodes)
        };
        let cancel = scope.cancel.clone();
        let started = StartedRun {
            scope: Arc::new(scope),
            graph: Arc::new(graph),
            trigger_input,
            trigger_items,
            started_sequence: receipt.sequence,
        };
        self.send(EngineTickInput::Started(started)).await;
        cancel
    }

    /// Waits until `check` holds over the stored rows, read again at each committed write.
    pub(in crate::engine::tick::turns) async fn wait_until(
        &mut self,
        check: impl Fn(&Connection) -> bool,
    ) {
        let rows = &self.rows;
        timeout(WAIT, self.changes.wait_for(|_| check(rows)))
            .await
            .expect("the loop writes in time")
            .expect("the log stays open");
    }

    /// The status of the step of `node_id`, `None` before its row is written.
    pub(in crate::engine::tick::turns) fn status(&self, node_id: &str) -> Option<String> {
        step_column(&self.rows, node_id, "status")
    }

    /// Every stored event's sequence, type, instant and payload, in sequence order.
    pub(in crate::engine::tick::turns) fn events(&self) -> Vec<(i64, String, String, Value)> {
        let reader = self.database.reader();
        let mut statement = reader
            .prepare(
                "SELECT sequence, type, occurred_at, payload FROM session_events \
                 ORDER BY sequence",
            )
            .expect("the test reads the events");
        statement
            .query_map([], |row| {
                let payload: String = row.get(3)?;
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    serde_json::from_str(&payload).expect("a stored payload is JSON"),
                ))
            })
            .expect("the test reads the events")
            .collect::<Result<_, _>>()
            .expect("each event reads")
    }

    /// The event of `event_type` on the step of `node_id`.
    pub(in crate::engine::tick::turns) fn event(
        &self,
        event_type: &str,
        node_id: &str,
    ) -> (i64, String, String, Value) {
        self.events()
            .into_iter()
            .find(|(_, stored_type, _, payload)| {
                stored_type == event_type && payload["nodeId"] == json!(node_id)
            })
            .unwrap_or_else(|| panic!("{node_id} has its {event_type}"))
    }

    /// The record lines whose word is `record`: a fault, a decision, an intent or an outcome.
    pub(in crate::engine::tick::turns) fn record_lines(
        &self,
        record: &str,
    ) -> Vec<serde_json::Map<String, Value>> {
        self.records
            .lines()
            .into_iter()
            .filter(|line| line.get("record") == Some(&json!(record)))
            .collect()
    }

    /// Sends a person's `answer` to the wait `wait_id`, with an approval's `gate` answer, and
    /// answers the loop's reply, or the error of a reply the loop dropped unsent.
    pub(in crate::engine::tick::turns) async fn answer(
        &self,
        wait_id: UuidTextForm,
        answer: PersonWaitAnswer,
        gate: Option<WorkflowGateAnswer>,
    ) -> Result<Result<(), PersonWaitRefusal>, RecvError> {
        let (reply, replied) = oneshot::channel();
        self.send(EngineTickInput::Answer(PersonWaitIntake {
            wait_id,
            answer,
            gate,
            at: WireInstant::now(),
            reply,
        }))
        .await;
        timeout(WAIT, replied)
            .await
            .expect("the loop replies in time")
    }

    /// Sends `answer`'s `Keep going` and answers the loop's reply, or the error of a reply the loop
    /// dropped unsent.
    pub(in crate::engine::tick::turns) async fn keep_going(
        &self,
        answer: KeepGoingAnswer,
    ) -> Result<Result<(), PersonWaitRefusal>, RecvError> {
        let (reply, replied) = oneshot::channel();
        self.send(EngineTickInput::KeepGoing(KeepGoingIntake {
            answer,
            at: WireInstant::now(),
            reply,
        }))
        .await;
        timeout(WAIT, replied)
            .await
            .expect("the loop replies in time")
    }

    /// Sends a person's cancel of the scope's run for `reason`, as [`Harness::cancel_input`]
    /// makes it, and answers the receiving end of the loop's reply.
    pub(in crate::engine::tick::turns) async fn cancel(&self, reason: &str) -> CancelReplied {
        let (input, replied) = self.cancel_input(reason);
        self.send(input).await;
        replied
    }

    /// A person's cancel of the scope's run for `reason`, its error carrying the reason, beside
    /// the receiving end of the loop's reply.
    pub(in crate::engine::tick::turns) fn cancel_input(
        &self,
        reason: &str,
    ) -> (EngineTickInput, CancelReplied) {
        let (reply, replied) = oneshot::channel();
        let input = EngineTickInput::Cancel(RunCancelIntake {
            run_id: self.scope.run_id,
            reason: Some(WorkflowCancelReason::new(reason.to_owned()).expect("a reason")),
            error: Some(uncoded_step_error(reason.to_owned())),
            reply,
        });
        (input, replied)
    }

    /// A connection of its own on the test database, for a read made off the test's task.
    pub(in crate::engine::tick::turns) fn reader(&self) -> Connection {
        self.database.reader()
    }

    /// Waits until every turn whose write the test has seen has ended, its clock read included:
    /// an answer naming no wait lands in a later turn, which refuses it.
    pub(in crate::engine::tick::turns) async fn wait_for_earlier_turns(&self) {
        let no_wait = UuidTextForm::new(NO_WAIT_ID).expect("the test's wait id");
        let reply = self
            .answer(
                no_wait,
                PersonWaitAnswer::Reply(NonEmptyText::new("Hello".to_owned()).expect("a reply")),
                None,
            )
            .await;
        assert_eq!(reply, Ok(Err(PersonWaitRefusal::NotWaiting)));
    }

    /// The wait id the step of `node_id` waits under.
    pub(in crate::engine::tick::turns) fn wait_id(&self, node_id: &str) -> UuidTextForm {
        UuidTextForm::new(&step_column(&self.rows, node_id, "wait_id").expect("the step waits"))
            .expect("a stored wait id is a UUID")
    }

    /// Waits until the asks and the points have taken `count` calls, and answers every call
    /// taken, in order.
    pub(in crate::engine::tick::turns) async fn ordered_calls(
        &self,
        count: usize,
    ) -> Vec<OrderedCall> {
        let mut calls = self.order.subscribe();
        timeout(WAIT, calls.wait_for(|calls| calls.len() >= count))
            .await
            .expect("the loop calls in time")
            .expect("the log stays open")
            .clone()
    }

    /// The instant the deadline clock is armed at, `None` while nothing is armed.
    pub(in crate::engine::tick::turns) fn armed(&self) -> Option<SystemTime> {
        self.deadlines.armed_instant().instant()
    }

    async fn send(&self, input: EngineTickInput) {
        self.inbox
            .send(input)
            .await
            .unwrap_or_else(|_| panic!("the loop takes the input"));
    }
}

/// `column` of the step of `node_id`, `None` before its row is written.
pub(in crate::engine::tick::turns) fn step_column(
    rows: &Connection,
    node_id: &str,
    column: &str,
) -> Option<String> {
    rows.query_row(
        &format!("SELECT {column} FROM workflow_steps WHERE node_id = ?1"),
        params![node_id],
        |row| row.get(0),
    )
    .ok()
}

/// `column` of attempt `attempt` of the step of `node_id`, `None` before its row is written.
pub(in crate::engine::tick::turns) fn attempt_column(
    rows: &Connection,
    node_id: &str,
    attempt: i64,
    column: &str,
) -> Option<String> {
    rows.query_row(
        &format!("SELECT {column} FROM workflow_steps WHERE node_id = ?1 AND attempt = ?2"),
        params![node_id, attempt],
        |row| row.get(0),
    )
    .ok()
}
