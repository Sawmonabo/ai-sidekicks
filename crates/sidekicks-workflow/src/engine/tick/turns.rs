//! The tick's loop: one task for the whole engine over the one dispatch every run's steps go
//! through, so the memory gate's line keeps ready order across runs. Each turn takes what arrived,
//! commits each run's share in one write, walks what committed and dispatches what the walk
//! readied.

mod inbox;
mod readying;
mod reports;

use reports::TurnAsk;
#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use rusqlite::Connection;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::wire::id::UuidTextForm;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::definition::document::{WorkflowDefinitionId, WorkflowNode};
use sidekicks_contracts::workflow::definition::item::{WorkflowItem, WorkflowStepError};
use sidekicks_contracts::workflow::kind::WorkflowNodeKindSpec;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::WorkflowStepStatus;
use sidekicks_contracts::workflow::run::step::record::{WorkflowPayloadRef, WorkflowStepKey};
use sidekicks_std::scheduler::armed_instant::InstantJob as _;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::stored_column::{closed_word, text_column};
use sidekicks_store::events::log_service::EventLogService;
use sidekicks_store::events::session::appender::SessionEventAppender;
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;
use tokio::sync::mpsc::error::TryRecvError;
use tokio::sync::{mpsc, oneshot};
use tokio::task::{JoinError, JoinSet};

use super::commit::{ReportedStep, RunTurnCommit, RunTurnCommitFailure};
use super::dispatch::{StepDispatch, fill_step_failure};
use super::live_runs::{LiveRun, LiveStep};
use super::node_settings::main_inputs;
use super::walk::WalkReady;
use super::{ReadyStep, RunSnapshot, StepReport, StepReportKind, StepSettlement};
use crate::engine::event_record::{EngineFault, EngineRecorder};
use crate::engine::ports::{StepAdmission, StepPayloadArtifacts};
use crate::engine::start::StartedRun;
use crate::engine::waits::answers::PersonWaitIntake;
use crate::engine::waits::{PersonWaitDeadlines, PersonWaitPorts, PersonWaitRefusal};
use crate::kinds::{NodeKindTable, StepFailure, uncoded_step_error};
use crate::runs::gate_resolution::RunEventKeys;

/// The most reports one turn takes, and the most inputs from its inbox, so a turn stays bounded.
const TURN_REPORT_LIMIT: usize = 256;

/// The statements the tick prepares on a read connection: the workflow's level, and a chain's
/// held steps and its question, which Keep going reads.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) const ENGINE_TICK_STATEMENT_CAPACITY: usize = 3;

// The level every step of the workflow's runs runs at, read again at each turn that dispatches.
const WORKFLOW_LEVEL_SQL: &str = "SELECT permission_level FROM workflow_definitions WHERE id = ?1";

// Why the kinds table lists every node of a live run.
const KIND_CHECKED: &str = "the start checked that the table lists every node's kind";

/// What reaches the tick from outside its own steps.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) enum EngineTickInput {
    /// A run the start wrote, which the tick walks from its trigger step.
    Started(StartedRun),
    /// A person's answer to a step waiting on them.
    Answer(PersonWaitIntake),
}

/// What an [`EngineTick`] drives runs through, reads, writes and is woken by.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct EngineTickDependencies {
    /// The one dispatch every run's steps go through.
    pub(crate) dispatch: StepDispatch,
    /// The event log each turn's write is appended to.
    pub(crate) event_log: Arc<EventLogService>,
    /// The read pool the workflows' levels are read through.
    pub(crate) pool: Arc<DatabaseReadPool>,
    /// The kinds the runs' nodes are looked up in.
    pub(crate) kinds: Arc<NodeKindTable>,
    /// The engine's record for this daemon life.
    pub(crate) recorder: Arc<EngineRecorder>,
    /// The store of a payload above the inline cap.
    pub(crate) payloads: Arc<dyn StepPayloadArtifacts>,
    /// The memory gate, weighed once per turn.
    pub(crate) admission: Arc<dyn StepAdmission>,
    /// The receiving end of the dispatch's report channel.
    pub(crate) reports: mpsc::Receiver<StepReport>,
    /// The receiving end of the tick's inbox; the loop ends when it closes.
    pub(crate) inbox: mpsc::Receiver<EngineTickInput>,
    /// The approval cards and questions a step waiting on a person asks through.
    pub(crate) person_waits: PersonWaitPorts,
    /// The deadline clock over every step waiting on a person, read again after a write moves a
    /// deadline.
    pub(crate) deadlines: Arc<PersonWaitDeadlines>,
}

/// The engine's tick: the live runs and the one loop that drives them.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct EngineTick {
    dispatch: StepDispatch,
    appender: SessionEventAppender,
    pool: Arc<DatabaseReadPool>,
    kinds: Arc<NodeKindTable>,
    recorder: Arc<EngineRecorder>,
    payloads: Arc<dyn StepPayloadArtifacts>,
    admission: Arc<dyn StepAdmission>,
    reports: mpsc::Receiver<StepReport>,
    inbox: mpsc::Receiver<EngineTickInput>,
    person_waits: PersonWaitPorts,
    deadlines: Arc<PersonWaitDeadlines>,
    /// Whether this turn's writes armed or cleared a deadline, took a late answer or dropped a
    /// run, so the deadline clock is read again at the turn's end.
    needs_deadline_read: bool,
    /// The waits of the runs dropped in this daemon life, whose rows keep them until the restart
    /// settles them; an answer to one is not taken.
    dropped_waits: HashSet<UuidTextForm>,
    /// The runs the tick drives, by id.
    runs: HashMap<WorkflowRunId, LiveRun>,
    /// The runs holding a next batch, in the order the batches were made.
    batched: Vec<WorkflowRunId>,
    /// One timer per retry attempt waiting out its wait, answering the attempt once it is due, or
    /// `None` when its run is canceled first. Dropping the tick drops them.
    retries: JoinSet<Option<WorkflowStepKey>>,
}

/// One run's share of a turn while it is gathered: its write, what it readied, the reports its
/// cancels queued to apply next, the last event whose write readies steps, the person waits it
/// opened, and the replies to the answers it settled.
struct RunTurn {
    commit: RunTurnCommit,
    readied: Vec<TurnReadied>,
    /// The person waits the turn opened, asked once its write commits.
    asks: Vec<TurnAsk>,
    /// The replies to the answers the turn settled, sent once its write commits.
    replies: Vec<oneshot::Sender<Result<(), PersonWaitRefusal>>>,
    /// The reports a cancel or a closed wave queued, applied in order after the report that
    /// queued them, so nothing recurses.
    follow_ups: VecDeque<StepReport>,
    /// The index and instant of the turn's last event that carries readied steps.
    last_readying_event: Option<(usize, WireInstant)>,
}

/// A step a turn readied, kept live once its write commits.
struct TurnReadied {
    ready: WalkReady,
    inputs: Vec<Vec<WorkflowItem>>,
    input_ref: WorkflowPayloadRef,
    next: ReadiedNext,
}

/// What follows a readied step once its write commits.
enum ReadiedNext {
    /// It is dispatched this turn.
    Dispatch,
    /// It is a failed step's next attempt, which runs once this wait is over.
    Retry(Duration),
    /// Its input could not be stored, so it fails at once with these reports.
    Fail(Vec<StepReport>),
    /// It was canceled in this turn without running, and keeps no live step.
    Canceled,
}

/// Why the workflows' levels could not be read.
#[derive(Debug, thiserror::Error)]
enum WorkflowLevelReadError {
    /// SQLite refused the read, or a stored level did not read as one.
    #[error("a read of a workflow's level failed")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read's blocking task did not
    /// finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
}

#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
impl EngineTick {
    /// The tick over `dependencies`, with no live run.
    pub(crate) fn new(dependencies: EngineTickDependencies) -> Self {
        let EngineTickDependencies {
            dispatch,
            event_log,
            pool,
            kinds,
            recorder,
            payloads,
            admission,
            reports,
            inbox,
            person_waits,
            deadlines,
        } = dependencies;
        Self {
            dispatch,
            appender: SessionEventAppender::new(event_log, SESSION_EVENT_VERSION.clone()),
            pool,
            kinds,
            recorder,
            payloads,
            admission,
            reports,
            inbox,
            person_waits,
            deadlines,
            needs_deadline_read: false,
            dropped_waits: HashSet::new(),
            runs: HashMap::new(),
            batched: Vec::new(),
            retries: JoinSet::new(),
        }
    }

    /// Runs turns until the inbox closes: waits for a report, a retry come due or an input unless
    /// a run holds a next batch, takes what is queued up to the turn's bound and every retry come
    /// due, and runs the turn.
    pub(crate) async fn run(mut self) {
        let mut reports = Vec::with_capacity(TURN_REPORT_LIMIT);
        let mut inputs = Vec::new();
        let mut due = Vec::new();
        loop {
            // A pinned step or an at-once failure has no driver to wake the loop.
            if self.batched.is_empty() {
                tokio::select! {
                    _ = self.reports.recv_many(&mut reports, TURN_REPORT_LIMIT) => {}
                    Some(timer) = self.retries.join_next(), if !self.retries.is_empty() => {
                        due.extend(retry_due(timer));
                    }
                    input = self.inbox.recv() => match input {
                        Some(input) => inputs.push(input),
                        None => return,
                    },
                }
            }
            while reports.len() < TURN_REPORT_LIMIT
                && let Ok(report) = self.reports.try_recv()
            {
                reports.push(report);
            }
            while inputs.len() < TURN_REPORT_LIMIT {
                match self.inbox.try_recv() {
                    Ok(input) => inputs.push(input),
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => return,
                }
            }
            while let Some(timer) = self.retries.try_join_next() {
                due.extend(retry_due(timer));
            }
            self.turn(
                std::mem::take(&mut inputs),
                std::mem::take(&mut reports),
                std::mem::take(&mut due),
            )
            .await;
        }
    }

    /// One turn: each run's share in arrival order, its next batch first, then the answers
    /// routed to it, and its retries come `due` with it, committed in one write per run; then one read of the dispatching runs'
    /// levels, their dispatch, one read of the deadline clock where a write moved a deadline, and
    /// one weigh of the memory gate.
    async fn turn(
        &mut self,
        inputs: Vec<EngineTickInput>,
        reports: Vec<StepReport>,
        due: Vec<WorkflowStepKey>,
    ) {
        let mut order = std::mem::take(&mut self.batched);
        let mut dispatching: Vec<(WorkflowRunId, Vec<ReadyStep>)> = Vec::new();
        let mut answers: HashMap<WorkflowRunId, Vec<PersonWaitIntake>> = HashMap::new();
        for input in inputs {
            match input {
                EngineTickInput::Started(run) => dispatching.push(self.start_run(run)),
                EngineTickInput::Answer(intake) => {
                    self.route_answer(intake, &mut order, &mut answers);
                }
            }
        }
        let mut arrived: HashMap<WorkflowRunId, Vec<StepReport>> = HashMap::new();
        for report in reports {
            let run_id = report.step.workflow_run_id;
            if !order.contains(&run_id) {
                order.push(run_id);
            }
            arrived.entry(run_id).or_default().push(report);
        }
        let mut due_by_run: HashMap<WorkflowRunId, Vec<WorkflowStepKey>> = HashMap::new();
        for step in due {
            let run_id = step.workflow_run_id;
            if !order.contains(&run_id) {
                order.push(run_id);
            }
            due_by_run.entry(run_id).or_default().push(step);
        }
        for run_id in order {
            let answers = answers.remove(&run_id).unwrap_or_default();
            let reports = arrived.remove(&run_id).unwrap_or_default();
            let due = due_by_run.remove(&run_id).unwrap_or_default();
            if let Some(readied) = self.run_turn(run_id, answers, reports, due).await
                && !readied.is_empty()
            {
                dispatching.push((run_id, readied));
            }
        }
        if !dispatching.is_empty() {
            self.dispatch_readied(dispatching).await;
        }
        // Awaited, so no two reads of the clock race.
        if std::mem::take(&mut self.needs_deadline_read) {
            Arc::clone(&self.deadlines).rearm().await;
        }
        self.admission.weigh();
    }

    /// Takes `run` into the live set and answers its trigger step, readied by the start's own
    /// write, to dispatch this turn on the start's items.
    fn start_run(&mut self, run: StartedRun) -> (WorkflowRunId, Vec<ReadyStep>) {
        let StartedRun {
            scope,
            graph,
            trigger_input,
            trigger_items,
            started_sequence,
        } = run;
        let run_id = scope.run_id;
        let record = self.recorder.for_run(run_id, Arc::clone(&scope.redaction));
        let mut live = LiveRun::new(scope, graph, record);
        let trigger = live
            .walk
            .start()
            .ready
            .pop()
            .expect("a walk starts by readying its trigger");
        let node = live
            .scope
            .nodes
            .get(&trigger.step.node_id)
            .expect("the trigger is one of the run's nodes");
        let spec = &self.kinds.kind_of(node).expect(KIND_CHECKED).spec;
        let mut inputs = vec![Vec::new(); spec.inputs.as_slice().len()];
        if let Some(first) = main_inputs(spec, inputs.iter_mut()).next() {
            *first = trigger_items;
        }
        let ready = ReadyStep {
            step: trigger.step,
            run_index: trigger.run_index,
            inputs: inputs.clone(),
            input_ref: trigger_input.clone(),
        };
        live.counts.moved(None, (WorkflowStepStatus::Pending, None));
        live.steps.insert(
            ready.step.execution_index.get(),
            LiveStep {
                step: ready.step.clone(),
                run_index: ready.run_index,
                status: WorkflowStepStatus::Pending,
                wait_cause: None,
                wait_id: None,
                wait_deadline_at: None,
                sources: trigger.sources,
                inputs,
                input_ref: trigger_input,
                readying_sequence: started_sequence,
                last_hold_report_at: None,
                cancel: None,
                is_winding_down: false,
                parked_agent_run: None,
            },
        );
        self.runs.insert(run_id, live);
        (run_id, vec![ready])
    }

    /// The share of the run `run_id` in this turn: its next batch, whose reports an earlier turn
    /// answered, so what that turn decided stands, then `answers`, then `reports`, each through
    /// the run's commit, the walk's answers added, a quiet run flushed, all in one write; each
    /// settled answer is replied to once the write commits. Answers
    /// the steps to dispatch, the retry attempts come `due` among them while they are still live,
    /// `pending` and undispatched, or `None` when the run is not live. A run left with no live
    /// step is over and leaves the live set; a run whose write fails leaves it with its steps
    /// canceled.
    async fn run_turn(
        &mut self,
        run_id: WorkflowRunId,
        answers: Vec<PersonWaitIntake>,
        reports: Vec<StepReport>,
        due: Vec<WorkflowStepKey>,
    ) -> Option<Vec<ReadyStep>> {
        let mut live = self.runs.remove(&run_id)?;
        let keys = RunEventKeys {
            session_id: live.scope.session_id,
            definition_id: live.scope.workflow_id,
            workflow_version_id: live.scope.workflow_version_id,
        };
        let mut turn = RunTurn {
            commit: RunTurnCommit::new(
                keys,
                run_id,
                live.counts,
                std::mem::take(&mut live.person_wait),
                Arc::clone(&self.payloads),
            ),
            readied: Vec::new(),
            asks: Vec::new(),
            replies: Vec::new(),
            follow_ups: VecDeque::new(),
            last_readying_event: None,
        };
        for report in std::mem::take(&mut live.next_batch) {
            self.apply_report(&mut live, &mut turn, report).await;
            self.apply_follow_ups(&mut live, &mut turn).await;
        }
        for intake in answers {
            self.apply_answer(&mut live, &mut turn, intake).await;
            self.apply_follow_ups(&mut live, &mut turn).await;
        }
        for report in reports {
            self.apply_report(&mut live, &mut turn, report).await;
            self.apply_follow_ups(&mut live, &mut turn).await;
        }
        if live.steps.is_empty() {
            self.flush(&mut live, &mut turn).await;
        }
        let RunTurn {
            commit,
            readied,
            asks,
            replies,
            ..
        } = turn;
        match commit
            .append(&self.appender, &live.record, live.live_steps())
            .await
        {
            Ok(committed) => {
                live.counts = committed.counts;
                live.person_wait = committed.person_wait;
                // The write answers each readied step in the order the turn readied it.
                let mut dispatched = Vec::new();
                for (turn_readied, (_step, readying_sequence)) in
                    readied.into_iter().zip(committed.readied)
                {
                    let TurnReadied {
                        ready,
                        inputs,
                        input_ref,
                        next,
                    } = turn_readied;
                    match next {
                        ReadiedNext::Dispatch => dispatched.push(ReadyStep {
                            step: ready.step.clone(),
                            run_index: ready.run_index,
                            inputs: inputs.clone(),
                            input_ref: input_ref.clone(),
                        }),
                        ReadiedNext::Retry(wait) => {
                            let cancel = live.scope.cancel.clone();
                            let attempt = ready.step.clone();
                            self.retries.spawn(async move {
                                tokio::select! {
                                    () = tokio::time::sleep(wait) => Some(attempt),
                                    () = cancel.cancelled() => None,
                                }
                            });
                        }
                        ReadiedNext::Fail(reports) => live.next_batch.extend(reports),
                        ReadiedNext::Canceled => continue,
                    }
                    live.steps.insert(
                        ready.step.execution_index.get(),
                        LiveStep {
                            step: ready.step,
                            run_index: ready.run_index,
                            status: WorkflowStepStatus::Pending,
                            wait_cause: None,
                            wait_id: None,
                            wait_deadline_at: None,
                            sources: ready.sources,
                            inputs,
                            input_ref,
                            readying_sequence,
                            last_hold_report_at: None,
                            cancel: None,
                            is_winding_down: false,
                            parked_agent_run: None,
                        },
                    );
                }
                for step in due {
                    if let Some(live_step) = live.steps.get(&step.execution_index.get())
                        && live_step.status == WorkflowStepStatus::Pending
                        && live_step.cancel.is_none()
                    {
                        dispatched.push(ReadyStep {
                            step,
                            run_index: live_step.run_index,
                            inputs: live_step.inputs.clone(),
                            input_ref: live_step.input_ref.clone(),
                        });
                    }
                }
                for reply in replies {
                    let _unheard = reply.send(Ok(()));
                }
                for (step, line) in std::mem::take(&mut live.deadline_lines) {
                    live.record.decision(Some(&step), line).await;
                }
                self.ask_people(&mut live, asks).await;
                self.needs_deadline_read |= std::mem::take(&mut live.needs_deadline_read);
                if live.steps.is_empty() {
                    self.recorder.end_run(run_id);
                    return Some(Vec::new());
                }
                if !live.next_batch.is_empty() {
                    self.batched.push(run_id);
                }
                self.runs.insert(run_id, live);
                Some(dispatched)
            }
            Err(failure) => {
                self.drop_failed_run(live, failure).await;
                None
            }
        }
    }

    /// Applies the reports the turn's last report queued, in order, each queuing its own after it.
    async fn apply_follow_ups(&self, live: &mut LiveRun, turn: &mut RunTurn) {
        while let Some(follow_up) = turn.follow_ups.pop_front() {
            self.apply_report(live, turn, follow_up).await;
        }
    }

    /// Ends the run of `live`, whose turn's write was refused: cancels its steps, deletes every
    /// artifact the write would have named and records the failure; the restart settles what the
    /// log holds. Its stored waits stay off the deadline clock, and an answer to one is not taken.
    async fn drop_failed_run(&mut self, live: LiveRun, failure: RunTurnCommitFailure) {
        let RunTurnCommitFailure {
            error,
            artifact_ids,
        } = failure;
        live.scope.cancel.cancel();
        self.dropped_waits.extend(
            live.steps
                .values()
                .filter_map(|live_step| live_step.wait_id),
        );
        self.deadlines.skip_run(live.scope.run_id);
        // The dropped run's deadline may be the one armed.
        self.needs_deadline_read = true;
        for artifact_id in &artifact_ids {
            if let Err(removal) = self.payloads.delete(artifact_id).await {
                live.record
                    .fault(None, EngineFault::TurnPayloadLeftBehind, &*removal)
                    .await;
            }
        }
        live.record
            .fault(None, EngineFault::TurnWriteFailed, &error)
            .await;
        self.recorder.end_run(live.scope.run_id);
    }

    /// Reads the levels of the dispatching runs' workflows in one read and dispatches each run's
    /// `readied` steps on a fresh snapshot, their answered reports opening its next batch. When
    /// the levels cannot be read, every one of those steps fails at once with that error.
    async fn dispatch_readied(&mut self, dispatching: Vec<(WorkflowRunId, Vec<ReadyStep>)>) {
        let mut workflow_ids: Vec<WorkflowDefinitionId> = Vec::new();
        for (run_id, _) in &dispatching {
            let workflow_id = self.runs[run_id].scope.workflow_id;
            if !workflow_ids.contains(&workflow_id) {
                workflow_ids.push(workflow_id);
            }
        }
        let levels = self
            .pool
            .read(ReadLength::Short, move |connection| {
                read_workflow_levels(connection, workflow_ids)
            })
            .await;
        for (run_id, readied) in dispatching {
            let live = self
                .runs
                .get_mut(&run_id)
                .expect("a dispatching run is live");
            match &levels {
                Ok(levels) => {
                    let snapshot = RunSnapshot {
                        outputs: Arc::new(live.outputs.clone()),
                        run_variables: Arc::clone(&live.run_variables),
                        permission_level: levels[&live.scope.workflow_id],
                    };
                    let execution_indices: Vec<u64> = readied
                        .iter()
                        .map(|ready| ready.step.execution_index.get())
                        .collect();
                    // The dispatch answers each step in the order it was handed.
                    let answered = self.dispatch.dispatch(&live.scope, &snapshot, readied);
                    for (execution_index, dispatched) in execution_indices.into_iter().zip(answered)
                    {
                        live.steps
                            .get_mut(&execution_index)
                            .expect("a dispatched step is live")
                            .cancel = Some(dispatched.cancel);
                        live.next_batch.extend(dispatched.reports);
                    }
                }
                Err(error) => {
                    let message = format!("the workflow's level could not be read: {error}");
                    for ready in readied {
                        let failure =
                            step_failure(live, &ready.step, StepFailure::Failed, message.clone());
                        live.next_batch.extend(failed_at_once(&ready.step, failure));
                    }
                }
            }
            if !live.next_batch.is_empty() && !self.batched.contains(&run_id) {
                self.batched.push(run_id);
            }
        }
    }

    /// What the tick knows of the live `step` of `live`, which the commit reads.
    fn reported<'run>(
        &'run self,
        live: &'run LiveRun,
        step: &WorkflowStepKey,
    ) -> ReportedStep<'run> {
        let live_step = live
            .steps
            .get(&step.execution_index.get())
            .expect("a reported step is live");
        let node = live
            .scope
            .nodes
            .get(&step.node_id)
            .expect("a step's node is the run's");
        ReportedStep {
            status: live_step.status,
            wait_cause: live_step.wait_cause,
            readying_sequence: live_step.readying_sequence,
            last_hold_report_at: live_step.last_hold_report_at.as_ref(),
            node,
            spec: self.spec(node),
            inputs: &live_step.inputs,
        }
    }

    /// The spec of `node`'s kind.
    fn spec(&self, node: &WorkflowNode) -> &WorkflowNodeKindSpec {
        &self.kinds.kind_of(node).expect(KIND_CHECKED).spec
    }
}

/// The failure `failed_as` of `step`, a step of `live`, saying `message`, filled for its node.
fn step_failure(
    live: &LiveRun,
    step: &WorkflowStepKey,
    failed_as: fn(Box<WorkflowStepError>) -> StepFailure,
    message: String,
) -> StepFailure {
    fill_step_failure(
        failed_as(Box::new(uncoded_step_error(message))),
        &step.node_id,
        &live.scope.redaction,
    )
}

/// The reports of `step` failing at once with `failure`, admitted with no hold, as a step with no
/// driver settles.
fn failed_at_once(step: &WorkflowStepKey, failure: StepFailure) -> Vec<StepReport> {
    let at = WireInstant::now();
    vec![
        StepReport {
            step: step.clone(),
            at: at.clone(),
            kind: StepReportKind::Admitted {
                hold_started_at: None,
            },
        },
        StepReport {
            step: step.clone(),
            at,
            kind: StepReportKind::Settled(StepSettlement::Failed {
                failure,
                log_lines: Vec::new(),
            }),
        },
    ]
}

/// The attempt a retry's `timer` answers come due, `None` when its run was canceled first. A
/// timer's panic is raised again here, since nothing aborts a timer while the tick lives.
fn retry_due(timer: Result<Option<WorkflowStepKey>, JoinError>) -> Option<WorkflowStepKey> {
    match timer {
        Ok(due) => due,
        Err(error) => std::panic::resume_unwind(error.into_panic()),
    }
}

/// The level of each workflow of `workflow_ids`, one indexed query each.
fn read_workflow_levels(
    connection: &Connection,
    workflow_ids: Vec<WorkflowDefinitionId>,
) -> Result<HashMap<WorkflowDefinitionId, PermissionLevel>, WorkflowLevelReadError> {
    let mut statement = connection.prepare_cached(WORKFLOW_LEVEL_SQL)?;
    let mut levels = HashMap::with_capacity(workflow_ids.len());
    for workflow_id in workflow_ids {
        let level = statement.query_row([workflow_id.text().as_str()], |row| {
            text_column(row, 0, closed_word)
        })?;
        levels.insert(workflow_id, level);
    }
    Ok(levels)
}
