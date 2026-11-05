//! The tick's loop: one task for the whole engine over the one dispatch every run's steps go
//! through, so the memory gate's line keeps ready order across runs. Each turn takes what arrived,
//! commits each run's share in one write, walks what committed and dispatches what the walk
//! readied.

mod reports;
#[cfg(test)]
mod tests;

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use rusqlite::Connection;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::definition::document::{WorkflowDefinitionId, WorkflowNode};
use sidekicks_contracts::workflow::definition::item::{WorkflowItem, WorkflowStepError};
use sidekicks_contracts::workflow::kind::WorkflowNodeKindSpec;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::WorkflowStepStatus;
use sidekicks_contracts::workflow::run::step::events::WorkflowStepSkipReason;
use sidekicks_contracts::workflow::run::step::record::{WorkflowPayloadRef, WorkflowStepKey};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::stored_column::{closed_word, text_column};
use sidekicks_store::events::log_service::EventLogService;
use sidekicks_store::events::session::appender::SessionEventAppender;
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TryRecvError;
use tokio::task::{JoinError, JoinSet};

use super::branch_cancellation::{BranchCancelReason, BranchLoser, cancel_branches};
use super::commit::{ReportedStep, RunTurnCommit, RunTurnCommitFailure};
use super::dispatch::{StepDispatch, fill_step_failure};
use super::live_runs::{LiveRun, LiveStep};
use super::node_settings::main_inputs;
use super::step_failure::{RunSibling, SiblingState};
use super::walk::{WalkReady, WalkTurn};
use super::{ReadyStep, RunSnapshot, StepReport, StepReportKind, StepSettlement};
use crate::engine::event_record::{EngineFault, EngineRecorder};
use crate::engine::ports::{StepAdmission, StepPayloadArtifacts};
use crate::engine::start::StartedRun;
use crate::expressions::lineage::{StepKey, StepOutput};
use crate::kinds::{NodeKindTable, StepFailure, uncoded_step_error};
use crate::runs::gate_resolution::RunEventKeys;
use crate::runs::step_payload::write_step_payload;

/// The most reports one turn takes, and the most starts, so a turn stays bounded.
const TURN_REPORT_LIMIT: usize = 256;

/// The statements the tick prepares on a read connection: the workflow's level.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) const ENGINE_TICK_STATEMENT_CAPACITY: usize = 1;

// The level every step of the workflow's runs runs at, read again at each turn that dispatches.
const WORKFLOW_LEVEL_SQL: &str = "SELECT permission_level FROM workflow_definitions WHERE id = ?1";

// Why the kinds table lists every node of a live run.
const KIND_CHECKED: &str = "the start checked that the table lists every node's kind";

/// What reaches the tick from outside its own steps.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) enum EngineTickInput {
    /// A run the start wrote, which the tick walks from its trigger step.
    Started(StartedRun),
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
    /// The runs the tick drives, by id.
    runs: HashMap<WorkflowRunId, LiveRun>,
    /// The runs holding a next batch, in the order the batches were made.
    batched: Vec<WorkflowRunId>,
    /// One timer per retry attempt waiting out its wait, answering the attempt once it is due, or
    /// `None` when its run is canceled first. Dropping the tick drops them.
    retries: JoinSet<Option<WorkflowStepKey>>,
}

/// One run's share of a turn while it is gathered: its write, what it readied, the reports its
/// cancels queued to apply next, and the last event whose write readies steps.
struct RunTurn {
    commit: RunTurnCommit,
    readied: Vec<TurnReadied>,
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
        let mut started = Vec::new();
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
                        Some(input) => started.push(input),
                        None => return,
                    },
                }
            }
            while reports.len() < TURN_REPORT_LIMIT
                && let Ok(report) = self.reports.try_recv()
            {
                reports.push(report);
            }
            while started.len() < TURN_REPORT_LIMIT {
                match self.inbox.try_recv() {
                    Ok(input) => started.push(input),
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => return,
                }
            }
            while let Some(timer) = self.retries.try_join_next() {
                due.extend(retry_due(timer));
            }
            self.turn(
                std::mem::take(&mut started),
                std::mem::take(&mut reports),
                std::mem::take(&mut due),
            )
            .await;
        }
    }

    /// One turn: each run's share in arrival order, its next batch first and its retries come
    /// `due` with it, committed in one write per run; then one read of the dispatching runs'
    /// levels, their dispatch, and one weigh of the memory gate.
    async fn turn(
        &mut self,
        started: Vec<EngineTickInput>,
        reports: Vec<StepReport>,
        due: Vec<WorkflowStepKey>,
    ) {
        let mut order = std::mem::take(&mut self.batched);
        let mut dispatching: Vec<(WorkflowRunId, Vec<ReadyStep>)> = Vec::new();
        for EngineTickInput::Started(run) in started {
            dispatching.push(self.start_run(run));
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
            let reports = arrived.remove(&run_id).unwrap_or_default();
            let due = due_by_run.remove(&run_id).unwrap_or_default();
            if let Some(readied) = self.run_turn(run_id, reports, due).await
                && !readied.is_empty()
            {
                dispatching.push((run_id, readied));
            }
        }
        if !dispatching.is_empty() {
            self.dispatch_readied(dispatching).await;
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

    /// The share of the run `run_id` in this turn: its next batch, then `reports`, each through
    /// the run's commit, the walk's answers added, a quiet run flushed, all in one write. Answers
    /// the steps to dispatch, the retry attempts come `due` among them while they are still live,
    /// `pending` and undispatched, or `None` when the run is not live. A run left with no live
    /// step is over and leaves the live set; a run whose write fails leaves it with its steps
    /// canceled.
    async fn run_turn(
        &mut self,
        run_id: WorkflowRunId,
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
            follow_ups: VecDeque::new(),
            last_readying_event: None,
        };
        let batch = std::mem::take(&mut live.next_batch);
        for report in batch.into_iter().chain(reports) {
            self.apply_report(&mut live, &mut turn, report).await;
            while let Some(follow_up) = turn.follow_ups.pop_front() {
                self.apply_report(&mut live, &mut turn, follow_up).await;
            }
        }
        if live.steps.is_empty() {
            self.flush(&mut live, &mut turn).await;
        }
        let RunTurn {
            commit, readied, ..
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

    /// Ends the run of `live`, whose turn's write was refused: cancels its steps, deletes every
    /// artifact the write would have named and records the failure; the restart settles what the
    /// log holds.
    async fn drop_failed_run(&self, live: LiveRun, failure: RunTurnCommitFailure) {
        let RunTurnCommitFailure {
            error,
            artifact_ids,
        } = failure;
        live.scope.cancel.cancel();
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

    /// Settles `step` in the walk with `outputs`, which move into the run's outputs beside its
    /// sources, and adds what the walk readies or skips to the turn on `readying`, the event
    /// whose write settles it and its instant.
    async fn settle_step(
        &self,
        live: &mut LiveRun,
        turn: &mut RunTurn,
        step: &WorkflowStepKey,
        readying: (usize, WireInstant),
        outputs: Vec<Vec<WorkflowItem>>,
    ) {
        let output_lengths: Vec<usize> = outputs.iter().map(Vec::len).collect();
        let walked = live.walk.settle(step, &output_lengths);
        let settled = live
            .steps
            .remove(&step.execution_index.get())
            .expect("a settled step is live");
        live.outputs.record(
            StepKey {
                node_id: step.node_id.clone(),
                execution_index: step.execution_index.get(),
            },
            StepOutput {
                sources: settled.sources,
                outputs,
            },
        );
        turn.last_readying_event = Some(readying.clone());
        self.take_walk(live, turn, walked, readying).await;
    }

    /// Flushes the quiet run of `live` until the walk answers nothing, each answer in this turn's
    /// write on the turn's last event that carries readied steps.
    async fn flush(&self, live: &mut LiveRun, turn: &mut RunTurn) {
        loop {
            let flushed = live.walk.flush();
            if flushed.ready.is_empty()
                && flushed.skipped.is_empty()
                && flushed.wins.is_empty()
                && flushed.canceled.is_empty()
            {
                return;
            }
            let readying = turn.last_readying_event.clone().expect(
                "a run goes quiet only in a turn whose last step left with an event that carries \
                 what its leaving readies",
            );
            self.take_walk(live, turn, flushed, readying).await;
        }
    }

    /// Adds what the walk answered to the turn: each skip's row and event, then each readied
    /// step's `pending` row on its stored first main input, on the event of the last skip it
    /// names as a source, or else on `readying`'s event.
    async fn take_walk(
        &self,
        live: &mut LiveRun,
        turn: &mut RunTurn,
        walked: WalkTurn,
        (readying_event, at): (usize, WireInstant),
    ) {
        let WalkTurn {
            ready,
            skipped,
            wins,
            canceled,
        } = walked;
        let mut skip_events: Vec<(u64, usize)> = Vec::with_capacity(skipped.len());
        for skip in &skipped {
            let (input_ref, output_ref) = match skip.reason {
                WorkflowStepSkipReason::Disabled => {
                    let inputs = live
                        .walk
                        .ready_inputs(&skip.step, &skip.sources, &live.outputs);
                    // A payload that cannot be stored is recorded on the skip, which passes its
                    // items on in the walk all the same.
                    let payload = self
                        .store_input(live, &skip.step, &inputs)
                        .await
                        .unwrap_or(WorkflowPayloadRef::Inline { items: Vec::new() });
                    (payload.clone(), payload)
                }
                WorkflowStepSkipReason::NoItems => (
                    WorkflowPayloadRef::Inline { items: Vec::new() },
                    WorkflowPayloadRef::Inline { items: Vec::new() },
                ),
            };
            let index = turn
                .commit
                .skipped(skip, &input_ref, &output_ref, at.clone());
            skip_events.push((skip.step.execution_index.get(), index));
            turn.last_readying_event = Some((index, at.clone()));
        }
        // A stopped run starts nothing new; the walk left the steps it canceled itself.
        let is_stopped = live.stop.is_some();
        let readied = ready
            .into_iter()
            .map(|ready| (ready, is_stopped, is_stopped))
            .chain(canceled.into_iter().map(|ready| (ready, true, false)));
        for (ready, is_canceled, is_walk_live) in readied {
            let event = ready
                .sources
                .iter()
                .flatten()
                .filter_map(|source| {
                    skip_events
                        .iter()
                        .find(|(skip, _)| *skip == source.execution_index.get())
                        .map(|&(_, index)| index)
                })
                .max()
                .unwrap_or(readying_event);
            let inputs = live
                .walk
                .ready_inputs(&ready.step, &ready.sources, &live.outputs);
            let stored = self.store_input(live, &ready.step, &inputs).await;
            let (input_ref, next) = match stored {
                Ok(input_ref) if is_canceled => (input_ref, ReadiedNext::Canceled),
                Ok(input_ref) => (input_ref, ReadiedNext::Dispatch),
                // As a skip's, a canceled step's input that cannot be stored is left empty.
                Err(_) if is_canceled => (
                    WorkflowPayloadRef::Inline { items: Vec::new() },
                    ReadiedNext::Canceled,
                ),
                Err(message) => {
                    let failure = step_failure(live, &ready.step, StepFailure::Failed, message);
                    (
                        WorkflowPayloadRef::Inline { items: Vec::new() },
                        ReadiedNext::Fail(failed_at_once(&ready.step, failure)),
                    )
                }
            };
            turn.commit.readied(&ready, input_ref.clone(), event);
            if is_canceled {
                turn.commit.canceled_unrun(&ready.step, &at);
                if is_walk_live {
                    live.walk.drop_step(&ready.step);
                }
            }
            turn.readied.push(TurnReadied {
                ready,
                inputs,
                input_ref,
                next,
            });
        }
        // A stopped run's own wave already holds every running step, so its wins are not
        // followed.
        if is_stopped {
            return;
        }
        for win in wins {
            let losers = reports::sort_losers(live, turn, win.losers, &at).await;
            let mut branch_losers = Vec::with_capacity(losers.len());
            for RunSibling { step, state } in losers {
                match state {
                    SiblingState::Running(cancel) => branch_losers.push(BranchLoser {
                        step,
                        is_running: true,
                        cancel,
                    }),
                    SiblingState::Held(cancel) => branch_losers.push(BranchLoser {
                        step,
                        is_running: false,
                        cancel,
                    }),
                    SiblingState::Waiting => reports::cancel_now(live, turn, step, &at).await,
                }
            }
            let (cancelings, wave) = cancel_branches(
                win.deciding,
                BranchCancelReason::FirstToArrive,
                branch_losers,
            );
            turn.follow_ups.extend(cancelings);
            live.waves.extend(wave);
        }
    }

    /// The first main input of `inputs`, the input lists of `step`, as the ref its row stores.
    /// Fails with the write's message when it cannot be stored, which is recorded on the step.
    async fn store_input(
        &self,
        live: &LiveRun,
        step: &WorkflowStepKey,
        inputs: &[Vec<WorkflowItem>],
    ) -> Result<WorkflowPayloadRef, String> {
        let spec = self.spec(
            live.scope
                .nodes
                .get(&step.node_id)
                .expect("a step's node is the run's"),
        );
        let first = main_inputs(spec, inputs)
            .next()
            .map_or(&[][..], Vec::as_slice);
        match write_step_payload(self.payloads.as_ref(), live.scope.session_id, step, first).await {
            Ok(input_ref) => Ok(input_ref),
            Err(error) => {
                live.record
                    .fault(Some(step), EngineFault::SettlementWriteFailed, &error)
                    .await;
                Err(error.to_string())
            }
        }
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
