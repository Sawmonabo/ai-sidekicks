//! The tick loop's test harness: a loop over a test database, the kinds its tests run, and
//! what the tests read back.

pub(in crate::engine::tick::turns) mod ports;
mod restart;
mod scripted_kinds;

use std::sync::Arc;
use std::time::{Duration, SystemTime};

use rusqlite::{Connection, params};
use serde_json::{Value, json};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::AnyValue;
use sidekicks_contracts::wire::id::UuidTextForm;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::definition::document::{WorkflowEdge, WorkflowNode};
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::run::control::WorkflowCancelReason;
use sidekicks_contracts::workflow::run::events::{WorkflowNodeRun, WorkflowRunStartedPayload};
use sidekicks_contracts::workflow::run::trigger::{
    WorkflowRunChainPlace, WorkflowRunMode, WorkflowRunTrigger, WorkflowStartedBy,
    WorkflowTriggerKind,
};
use sidekicks_std::scheduler::armed_instant::InstantJob as _;
use sidekicks_std::scheduler::test_wall_clock::TestWallClock;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log};
use sidekicks_store::events::session::appender::{
    SessionEventAppender, SessionEventDraft, SessionEventLinkage,
};
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;
use tokio::sync::oneshot::error::RecvError;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use self::restart::{DaemonLife, LifeParts};
use self::scripted_kinds::{Signals, kinds};
use crate::engine::deadlines::EngineDeadlines;
use crate::engine::event_record::EngineRecorder;
use crate::engine::partial_run::PartialRunPlan;
use crate::engine::ports::kept_payloads::KeptPayloads;
use crate::engine::ports::noticed_sessions::NoticedSessions;
use crate::engine::ports::run_limits::ScriptedRunLimits;
use crate::engine::ports::scripted_agent_runs::ScriptedAgentRunner;
use crate::engine::ports::{EngineRecordSink, KeptEngineRecords};
use crate::engine::start::{StartedNodeRun, StartedRun, StartedTrigger};
use crate::engine::tick::commit::SessionEventId;
use crate::engine::tick::turns::ending::RunCancelRefusal;
use crate::engine::tick::turns::tests::harness::ports::{
    OrderLog, OrderedCall, RecordingAsks, RecordingSnapshotPoints,
};
use crate::engine::tick::turns::{EngineTickInput, RunCancelIntake};
use crate::engine::tick::{RunGraph, RunScope, StepReport, test_run_scope};
use crate::engine::waits::answers::PersonWaitIntake;
use crate::engine::waits::{PersonWaitAnswer, PersonWaitRefusal};
use crate::kinds::{NodeKindTable, uncoded_step_error};
use crate::runs::creation::{
    WorkflowRunCreation, trigger_step_key, workflow_run_creation_statements,
};
use crate::runs::gate_resolution::WorkflowGateAnswer;
use crate::runs::gate_resolution::tests::with_card_answer;
use crate::runs::step_payload::write_step_payload;
use crate::schema::schema_parts;
use crate::test_rows::insert_workflow_version_body;

/// How long a test waits for what the loop must write.
pub(in crate::engine::tick::turns) const WAIT: Duration = Duration::from_secs(10);
/// A wait id no step ever waits under, which the turn barrier answers.
const NO_WAIT_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4eff";
/// How long a test waits to see that the loop writes nothing more.
pub(in crate::engine::tick::turns) const QUIET: Duration = Duration::from_millis(300);

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
    /// The event log every daemon life of the test appends through.
    log: TestLog,
    /// The running loop of the current daemon life, which ends once its inbox closes.
    tick_task: JoinHandle<()>,
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
        let log = open_log(&database, None).await;
        let scope = test_run_scope(WorkflowRunMode::Manual, Vec::new());
        let changes = log.followers.change_count(&scope.session_id);
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
        let limits = Arc::new(ScriptedRunLimits::default());
        // The stored deadlines are real instants, so the test clock starts at the real clock.
        let clock = Arc::new(TestWallClock::default());
        clock.set_now(SystemTime::now());
        let order = Arc::new(OrderLog::new(Vec::new()));
        let asks = Arc::new(RecordingAsks::new(database.reader(), Arc::clone(&order)));
        let points = Arc::new(RecordingSnapshotPoints::new(Arc::clone(&order)));
        let notices = Arc::new(NoticedSessions::default());
        let DaemonLife {
            tick,
            inbox,
            reports,
            deadlines,
            agents,
        } = DaemonLife::start(&LifeParts {
            database: &database,
            log: &log,
            kinds: &kinds,
            recorder: &recorder,
            payloads: &payloads,
            asks: &asks,
            points: &points,
            notices: &notices,
            clock: &clock,
            limits: &limits,
        });
        let tick_task = tokio::spawn(tick.run());
        Self {
            tick_task,
            rows: database.reader(),
            database,
            appender: SessionEventAppender::new(
                Arc::clone(&log.service),
                SESSION_EVENT_VERSION.clone(),
            ),
            log,
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
    /// earlier run stored it, and writes the run of the scope's run id, mode and pins as the start
    /// does, on `trigger_items`; `before_start` runs once the run is stored and before the loop
    /// takes it. Answers the run's cancel.
    pub(in crate::engine::tick::turns) async fn start(
        &self,
        nodes: Vec<WorkflowNode>,
        edges: &[WorkflowEdge],
        trigger_items: Vec<WorkflowItem>,
        before_start: impl FnOnce(&Connection),
    ) -> CancellationToken {
        self.start_run::<fn(&Connection, &RunGraph) -> PartialRunPlan, _>(
            nodes,
            edges,
            Ok(trigger_items),
            before_start,
        )
        .await
    }

    /// Stores the workflow as [`Harness::start`] does and writes the scope's run as the node run
    /// `node_run` that reuses its trigger's step, then hands the loop the seed of the plan `plan`
    /// makes over the stored rows and the run's graph, as the start hands it on: target sealed,
    /// reused outputs read back, another session's payloads stored again in the run's.
    pub(in crate::engine::tick::turns) async fn start_node_run(
        &self,
        nodes: Vec<WorkflowNode>,
        edges: &[WorkflowEdge],
        node_run: WorkflowNodeRun,
        plan: impl FnOnce(&Connection, &RunGraph) -> PartialRunPlan,
    ) -> CancellationToken {
        self.start_run(nodes, edges, Err((node_run, plan)), |_| {})
            .await
    }

    /// Writes the scope's run as [`Harness::start`] does, on its trigger's items or as a node run
    /// whose plan is made once the workflow is stored, and hands it to the loop.
    async fn start_run<
        Plan: FnOnce(&Connection, &RunGraph) -> PartialRunPlan,
        Before: FnOnce(&Connection),
    >(
        &self,
        nodes: Vec<WorkflowNode>,
        edges: &[WorkflowEdge],
        opening: Result<Vec<WorkflowItem>, (WorkflowNodeRun, Plan)>,
        before_start: Before,
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
                &json!({
                    "name": "Loop", "trigger": nodes[0], "nodes": nodes[1..], "edges": edges,
                }),
            );
        }
        let trigger = WorkflowRunTrigger {
            kind: WorkflowTriggerKind::Manual,
            node_id: nodes[0].id.clone(),
        };
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
        let started_at = WireInstant::now();
        let run_started_at = started_at.timestamp().expect("a stored instant reads");
        let (started_trigger, node_run) = match opening {
            Ok(items) => {
                let input_ref = write_step_payload(
                    self.payloads.as_ref(),
                    base.session_id,
                    &trigger_step_key(base.run_id, &trigger),
                    &items,
                )
                .await
                .expect("the trigger's input is stored");
                (Some(StartedTrigger { input_ref, items }), None)
            }
            Err((node_run, plan)) => (None, Some((node_run, plan(&self.rows, &graph)))),
        };
        let trigger_input = started_trigger
            .as_ref()
            .map(|started| started.input_ref.clone());
        let node_run_record = node_run.as_ref().map(|(node_run, _)| node_run.clone());
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
            trigger_input: trigger_input.clone(),
            node_run: node_run_record.clone(),
            retried_run_id: None,
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
                node_run: node_run_record,
                retried_workflow_run_id: None,
                input_ref: trigger_input,
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
        let scope = RunScope {
            run_id: base.run_id,
            trigger,
            run_started_at,
            pins: base.pins.clone(),
            ..test_run_scope(base.mode, nodes)
        };
        let cancel = scope.cancel.clone();
        let node_run = match node_run {
            Some((node_run, plan)) => {
                let mut started = StartedNodeRun::from_plan(&graph, plan, self.payloads.as_ref())
                    .await
                    .expect("the reused outputs read back");
                started.sealed = Some(graph.place(&node_run.node_id));
                started
                    .store_in_session(self.payloads.as_ref(), base.session_id, &mut Vec::new())
                    .await
                    .expect("the reused payloads are stored in the run's session");
                Some(started)
            }
            None => None,
        };
        let started = StartedRun {
            scope: Arc::new(scope),
            graph: Arc::new(graph),
            trigger: started_trigger,
            node_run,
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

    /// Sends a person's `answer` to the wait `wait_id`, with an approval's `gate` answer and its
    /// card's, and answers the loop's reply, or the error of a reply the loop dropped unsent.
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
            gate: gate.map(|gate| with_card_answer(gate, self.scope.session_id)),
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
