//! The tick loop's test harness: a loop over a test database, the kinds its tests run, and
//! what the tests read back.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use futures::future::BoxFuture;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::question::QuestionId;
use sidekicks_contracts::wire::AnyValue;
use sidekicks_contracts::wire::id::{UuidTextForm, mint_uuid_v7};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::definition::document::{WorkflowEdge, WorkflowNode};
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::run::events::WorkflowRunStartedPayload;
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use sidekicks_contracts::workflow::run::trigger::{
    WorkflowRunChainPlace, WorkflowRunMode, WorkflowRunTrigger, WorkflowStartedBy,
    WorkflowTriggerKind,
};
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_std::scheduler::test_wall_clock::TestWallClock;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log};
use sidekicks_store::events::session::appender::{
    SessionEventAppender, SessionEventDraft, SessionEventLinkage,
};
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;
use tokio::sync::{Notify, mpsc, watch};
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use crate::engine::event_record::EngineRecorder;
use crate::engine::ports::kept_payloads::KeptPayloads;
use crate::engine::ports::{
    ApprovalCardRaiser, EnginePorts, EngineRecordSink, FormQuestionRequest, KeptEngineRecords,
    PersonWaitQuestions, PortError, REFUSED_PORT_CALL, ReplyQuestionRequest, ScriptedGate,
    StepAdmission, StepPayloadArtifacts, WorkflowApprovalCardRequest, refusing_engine_ports,
};
use crate::engine::start::StartedRun;
use crate::engine::tick::dispatch::test_dispatch_recording;
use crate::engine::tick::turns::{
    ENGINE_TICK_STATEMENT_CAPACITY, EngineTick, EngineTickDependencies, EngineTickInput,
};
use crate::engine::tick::{RunGraph, RunScope, StepReport, test_run_scope};
use crate::engine::waits::{PERSON_WAIT_STATEMENT_CAPACITY, PersonWaitDeadlines, PersonWaitPorts};
use crate::kinds::step_context::StepContext;
use crate::kinds::{
    NodeExecutor, NodeKindTable, PassThroughExecutor, StepFailure, StepOutcome, test_kind,
    uncoded_step_error,
};
use crate::runs::creation::{
    WorkflowRunCreation, trigger_step_key, workflow_run_creation_statements,
};
use crate::runs::step_payload::write_step_payload;
use crate::schema::schema_parts;
use crate::test_rows::insert_workflow_version_body;

/// How long a test waits for what the loop must write.
pub(in crate::engine::tick::turns) const WAIT: Duration = Duration::from_secs(10);
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
                Script::Empty => vec![Vec::new()],
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
            }))
        })
    }

    fn readies_on_first_input(&self, _node: &WorkflowNode) -> bool {
        matches!(self.script, Script::First)
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

/// Ten items of 7 KiB each, above the inline cap together.
pub(in crate::engine::tick::turns) fn large_items() -> Vec<WorkflowItem> {
    (0..10)
        .map(|index| item(json!({ "index": index, "text": "x".repeat(7 * 1024) })))
        .collect()
}

/// A kind `kind` with `input_count` main inputs and one main output, run by `executor`.
fn kind(
    kind: &str,
    category: &str,
    input_count: usize,
    executor: Box<dyn NodeExecutor>,
) -> crate::kinds::NodeKind {
    let inputs: Vec<Value> = (0..input_count)
        .map(|index| json!({ "type": "main", "id": format!("inputs/main/{index}"), "label": "In" }))
        .collect();
    test_kind(
        json!({
            "kind": kind, "version": 1, "category": category, "displayName": kind,
            "description": "A test kind.", "icon": "test", "params": [],
            "outputsDeriveFromParams": false, "inputs": inputs,
            "outputs": [{ "type": "main", "id": "outputs/main/0", "label": "Out" }],
        }),
        None,
        executor,
    )
}

/// The test's kinds: a trigger and a step passing their inputs on, and one kind per script.
fn kinds(signal: &Arc<Signals>) -> Arc<NodeKindTable> {
    let scripted = |name: &str, inputs: usize, script: Script| {
        kind(
            name,
            "developer",
            inputs,
            Box::new(ScriptedExecutor {
                script,
                signal: Arc::clone(signal),
            }),
        )
    };
    Arc::new(
        NodeKindTable::new(vec![
            kind("test.trigger", "trigger", 1, Box::new(PassThroughExecutor)),
            kind("test.step", "developer", 1, Box::new(PassThroughExecutor)),
            kind("test.pair", "developer", 2, Box::new(PassThroughExecutor)),
            scripted("test.empty", 1, Script::Empty),
            scripted("test.large", 1, Script::Large),
            scripted("test.wait", 1, Script::AwaitCancel),
            scripted("test.level", 1, Script::Level),
            scripted("test.flaky", 1, Script::Flaky),
            scripted("test.linger", 1, Script::Linger),
            scripted("test.first", 2, Script::First),
            scripted("test.gated", 1, Script::Gated),
            scripted("test.gatedFailure", 1, Script::GatedFailure),
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

/// One call the test's asks took: what it raised or opened, for which step and wait, and the
/// step's row, its status and wait id, as the call read it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::engine::tick::turns) struct RecordedAsk {
    /// `approval`, `form` or `reply`.
    pub(in crate::engine::tick::turns) kind: &'static str,
    /// The step that waits.
    pub(in crate::engine::tick::turns) step: WorkflowStepKey,
    /// The wait the answer settles.
    pub(in crate::engine::tick::turns) wait_id: UuidTextForm,
    /// The step row's status at the call, `None` with no row.
    pub(in crate::engine::tick::turns) row_status: Option<String>,
    /// The step row's wait id at the call.
    pub(in crate::engine::tick::turns) row_wait_id: Option<String>,
}

/// The approval cards and questions of a test, over their own connection to its database: each
/// call is kept with what the step's row reads at the call, and every call fails while told to.
pub(in crate::engine::tick::turns) struct RecordingAsks {
    rows: Mutex<Connection>,
    calls: Mutex<Vec<RecordedAsk>>,
    is_refusing: AtomicBool,
}

impl RecordingAsks {
    /// Makes every later call fail, as a card or question that cannot be written.
    pub(in crate::engine::tick::turns) fn refuse_every_call(&self) {
        self.is_refusing.store(true, Ordering::SeqCst);
    }

    /// Every call taken, in order.
    pub(in crate::engine::tick::turns) fn calls(&self) -> Vec<RecordedAsk> {
        lock(&self.calls).clone()
    }

    // Keeps the call of `kind` for `step` under `wait_id`, failing it while told to.
    fn take(
        &self,
        kind: &'static str,
        step: WorkflowStepKey,
        wait_id: UuidTextForm,
    ) -> Result<(), PortError> {
        let (row_status, row_wait_id) = lock(&self.rows)
            .query_row(
                "SELECT status, wait_id FROM workflow_steps \
                 WHERE workflow_run_id = ?1 AND execution_index = ?2",
                params![
                    step.workflow_run_id.text().as_str(),
                    i64::try_from(step.execution_index.get()).expect("a test's index is small")
                ],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_or((None, None), |(status, wait_id)| (Some(status), wait_id));
        lock(&self.calls).push(RecordedAsk {
            kind,
            step,
            wait_id,
            row_status,
            row_wait_id,
        });
        if self.is_refusing.load(Ordering::SeqCst) {
            return Err("the test's asks refuse every call".into());
        }
        Ok(())
    }
}

impl ApprovalCardRaiser for RecordingAsks {
    fn raise(&self, request: WorkflowApprovalCardRequest) -> BoxFuture<'_, Result<(), PortError>> {
        let step = request.step.expect("a step's approval names its step");
        let taken = self.take("approval", step, request.wait_id);
        Box::pin(async move { taken })
    }
}

impl PersonWaitQuestions for RecordingAsks {
    fn open_form(
        &self,
        request: FormQuestionRequest,
    ) -> BoxFuture<'_, Result<QuestionId, PortError>> {
        let taken = self.take("form", request.step, request.wait_id);
        Box::pin(async move { taken.map(|()| fresh_question_id()) })
    }

    fn open_reply(
        &self,
        request: ReplyQuestionRequest,
    ) -> BoxFuture<'_, Result<QuestionId, PortError>> {
        let taken = self.take("reply", request.step, request.wait_id);
        Box::pin(async move { taken.map(|()| fresh_question_id()) })
    }

    fn reattach<'call>(
        &'call self,
        _wait_id: &'call UuidTextForm,
    ) -> BoxFuture<'call, Result<(), PortError>> {
        Box::pin(async { Err(REFUSED_PORT_CALL.into()) })
    }
}

fn fresh_question_id() -> QuestionId {
    QuestionId::try_from(mint_uuid_v7()).expect("a minted id is a UUID")
}

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
    inbox: mpsc::Sender<EngineTickInput>,
    pub(in crate::engine::tick::turns) scope: RunScope,
    /// The asks the loop's waits go through.
    pub(in crate::engine::tick::turns) asks: Arc<RecordingAsks>,
    /// The wall clock the deadline clock's scheduler runs on, set to the real clock at the start.
    pub(in crate::engine::tick::turns) clock: Arc<TestWallClock>,
    /// The loop's deadline clock.
    pub(in crate::engine::tick::turns) deadlines: Arc<PersonWaitDeadlines>,
    /// A sending end of the loop's report channel, which the test reports on as a driver would.
    pub(in crate::engine::tick::turns) reports: mpsc::Sender<StepReport>,
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
        let ports = EnginePorts {
            admission: Arc::clone(&gate) as Arc<dyn StepAdmission>,
            payloads: Arc::clone(&payloads) as Arc<dyn StepPayloadArtifacts>,
            ..refusing_engine_ports()
        };
        let (dispatch, received_reports, reports) =
            test_dispatch_recording(&database, ports, Arc::clone(&kinds), Arc::clone(&recorder));
        // The stored deadlines are real instants, so the test clock starts at the real clock.
        let clock = Arc::new(TestWallClock::default());
        clock.set_now(SystemTime::now());
        let wall_clock: Arc<TestWallClock> = Arc::clone(&clock);
        let scheduler = Arc::new(Scheduler::start(wall_clock, None, watch::channel(0).1));
        let deadlines = PersonWaitDeadlines::new(
            scheduler,
            Arc::new(DatabaseReadPool::new(
                database.path(),
                PERSON_WAIT_STATEMENT_CAPACITY,
            )),
            reports.clone(),
        );
        let asks = Arc::new(RecordingAsks {
            rows: Mutex::new(database.reader()),
            calls: Mutex::new(Vec::new()),
            is_refusing: AtomicBool::new(false),
        });
        let (inbox, received) = mpsc::channel(4);
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
            clock,
            deadlines,
            reports,
        }
    }

    /// Stores the workflow of `nodes` and `edges`, the node `trigger` its trigger, and writes its
    /// run as the start does, on `trigger_items`; `before_start` runs once the run is stored and
    /// before the loop takes it. Answers the run's cancel.
    pub(in crate::engine::tick::turns) async fn start(
        &self,
        nodes: Vec<WorkflowNode>,
        edges: &[WorkflowEdge],
        trigger_items: Vec<WorkflowItem>,
        before_start: impl FnOnce(&Connection),
    ) -> CancellationToken {
        let base = &self.scope;
        insert_workflow_version_body(
            &self.rows,
            base.workflow_id.text().as_str(),
            base.workflow_version_id.text().as_str(),
            &json!({ "name": "Loop", "nodes": nodes, "edges": edges }),
        );
        let trigger = WorkflowRunTrigger {
            kind: WorkflowTriggerKind::Manual,
            node_id: nodes[0].id.clone(),
        };
        let started_at = WireInstant::now();
        let trigger_input = write_step_payload(
            self.payloads.as_ref(),
            base.session_id,
            &trigger_step_key(base.run_id, &trigger),
            &trigger_items,
        )
        .await
        .expect("the trigger's input is stored");
        let creation = WorkflowRunCreation {
            workflow_run_id: base.run_id,
            workflow_version_id: base.workflow_version_id,
            session_id: base.session_id,
            mode: WorkflowRunMode::Manual,
            trigger: trigger.clone(),
            started_by: WorkflowStartedBy::Schedule {},
            chain: WorkflowRunChainPlace::Starts {},
            execution_context: None,
            provider: None,
            started_at: started_at.clone(),
            trigger_input: trigger_input.clone(),
        };
        let draft = SessionEventDraft::of_session(
            base.session_id,
            &SessionEvent::WorkflowRunStarted(WorkflowRunStartedPayload {
                session_id: base.session_id,
                workflow_run_id: base.run_id,
                definition_id: base.workflow_id,
                workflow_version_id: base.workflow_version_id,
                mode: WorkflowRunMode::Manual,
                started_by: WorkflowStartedBy::Schedule {},
                trigger: trigger.clone(),
                chain: WorkflowRunChainPlace::Starts {},
                provider: None,
                input_ref: trigger_input.clone(),
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
            trigger,
            ..test_run_scope(WorkflowRunMode::Manual, nodes)
        };
        let cancel = scope.cancel.clone();
        let started = StartedRun {
            scope: Arc::new(scope),
            graph: Arc::new(graph),
            trigger_input,
            trigger_items,
            started_sequence: receipt.sequence,
        };
        self.inbox
            .send(EngineTickInput::Started(started))
            .await
            .unwrap_or_else(|_| panic!("the loop takes the run"));
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

    /// The record lines of the fault `fault`.
    pub(in crate::engine::tick::turns) fn faults(
        &self,
        fault: &str,
    ) -> Vec<serde_json::Map<String, Value>> {
        self.records
            .lines()
            .into_iter()
            .filter(|line| line.get("record") == Some(&json!(fault)))
            .collect()
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
