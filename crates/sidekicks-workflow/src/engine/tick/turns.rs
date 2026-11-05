//! The tick's loop: one task for the whole engine over the one dispatch every run's steps go
//! through, so the memory gate's line keeps ready order across runs. Each turn takes what arrived,
//! commits each run's share in one write, walks what committed and dispatches what the walk
//! readied.

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::sync::Arc;

use rusqlite::Connection;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::definition::document::{WorkflowDefinitionId, WorkflowNode};
use sidekicks_contracts::workflow::definition::item::{WorkflowItem, WorkflowStepError};
use sidekicks_contracts::workflow::kind::WorkflowNodeKindSpec;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::{WorkflowStepStatus, WorkflowWaitCause};
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

use super::commit::{
    ReportedStep, RunTurnCommit, RunTurnCommitFailure, SettlementAnswer, SettlementWriteFailure,
};
use super::dispatch::{StepDispatch, fill_step_failure};
use super::live_runs::{LiveRun, LiveStep};
use super::node_settings::main_inputs;
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
}

/// One run's share of a turn while it is gathered: its write, what it readied and the last event
/// whose write readies steps.
struct RunTurn {
    commit: RunTurnCommit,
    readied: Vec<TurnReadied>,
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
    /// It is a failed step's next attempt, which runs after its retry's wait.
    Retry,
    /// Its input could not be stored, so it fails at once with these reports.
    Fail(Vec<StepReport>),
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
        }
    }

    /// Runs turns until the inbox closes: waits for a report or an input unless a run holds a
    /// next batch, takes what is queued up to the turn's bound, and runs the turn.
    pub(crate) async fn run(mut self) {
        let mut reports = Vec::with_capacity(TURN_REPORT_LIMIT);
        let mut started = Vec::new();
        loop {
            // A pinned step or an at-once failure has no driver to wake the loop.
            if self.batched.is_empty() {
                tokio::select! {
                    _ = self.reports.recv_many(&mut reports, TURN_REPORT_LIMIT) => {}
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
            self.turn(std::mem::take(&mut started), std::mem::take(&mut reports))
                .await;
        }
    }

    /// One turn: each run's share in arrival order, its next batch first, committed in one write
    /// per run; then one read of the dispatching runs' levels, their dispatch, and one weigh of
    /// the memory gate.
    async fn turn(&mut self, started: Vec<EngineTickInput>, reports: Vec<StepReport>) {
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
        for run_id in order {
            let reports = arrived.remove(&run_id).unwrap_or_default();
            if let Some(readied) = self.run_turn(run_id, reports).await
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
                status: WorkflowStepStatus::Pending,
                wait_cause: None,
                sources: trigger.sources,
                inputs,
                input_ref: trigger_input,
                readying_sequence: started_sequence,
                last_hold_report_at: None,
            },
        );
        self.runs.insert(run_id, live);
        (run_id, vec![ready])
    }

    /// The share of the run `run_id` in this turn: its next batch, then `reports`, each through
    /// the run's commit, the walk's answers added, a quiet run flushed, all in one write. Answers
    /// the steps to dispatch, or `None` when the run is not live. A run left with no live step is
    /// over and leaves the live set; a run whose write fails leaves it with its steps canceled.
    async fn run_turn(
        &mut self,
        run_id: WorkflowRunId,
        reports: Vec<StepReport>,
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
            last_readying_event: None,
        };
        let batch = std::mem::take(&mut live.next_batch);
        for report in batch.into_iter().chain(reports) {
            self.apply_report(&mut live, &mut turn, report).await;
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
                        ReadiedNext::Retry => {}
                        ReadiedNext::Fail(reports) => live.next_batch.extend(reports),
                    }
                    live.steps.insert(
                        ready.step.execution_index.get(),
                        LiveStep {
                            step: ready.step,
                            status: WorkflowStepStatus::Pending,
                            wait_cause: None,
                            sources: ready.sources,
                            inputs,
                            input_ref,
                            readying_sequence,
                            last_hold_report_at: None,
                        },
                    );
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

    /// Adds `report` of a live step of `live` to the turn and follows what a settlement answers;
    /// a report of a step that is not live is dropped.
    async fn apply_report(&self, live: &mut LiveRun, turn: &mut RunTurn, report: StepReport) {
        let execution_index = report.step.execution_index.get();
        if !live.steps.contains_key(&execution_index) {
            return;
        }
        let hold = match &report.kind {
            StepReportKind::WaitingOnPool { .. } => Some(Some(report.at.clone())),
            StepReportKind::Admitted { .. } => Some(None),
            StepReportKind::Settled(_) => {
                let step = report.step.clone();
                let at = report.at.clone();
                let answer = self.report_settlement(live, &mut turn.commit, report).await;
                self.follow_settlement(live, turn, &step, at, answer).await;
                return;
            }
            StepReportKind::Started { .. }
            | StepReportKind::Progressed
            | StepReportKind::Canceling
            | StepReportKind::BranchesCanceled { .. } => None,
        };
        let step = report.step.clone();
        turn.commit
            .report(report, self.reported(live, &step))
            .await
            .expect("only a settlement stores a payload");
        if let Some(last_hold_report_at) = hold {
            let status = if last_hold_report_at.is_some() {
                WorkflowStepStatus::WaitingMemory
            } else {
                WorkflowStepStatus::Running
            };
            live.move_step(execution_index, status, None);
            if let Some(live_step) = live.steps.get_mut(&execution_index) {
                live_step.last_hold_report_at = last_hold_report_at;
            }
        }
    }

    /// Adds the settlement `report` to `commit` and answers what follows. A settlement whose
    /// payload cannot be stored fails its step with that error in its place, and a failure whose
    /// passed-on output cannot be stored either ends the run, which stores nothing more.
    async fn report_settlement(
        &self,
        live: &LiveRun,
        commit: &mut RunTurnCommit,
        report: StepReport,
    ) -> SettlementAnswer {
        let step = report.step.clone();
        let at = report.at.clone();
        let failure = match commit.report(report, self.reported(live, &step)).await {
            Ok(answer) => return answer.expect("a settlement answers"),
            Err(failure) => failure,
        };
        let failed = self
            .fail_in_place(live, &step, at.clone(), failure, StepFailure::Failed)
            .await;
        let failure = match commit.report(failed, self.reported(live, &step)).await {
            Ok(answer) => return answer.expect("a settlement answers"),
            Err(failure) => failure,
        };
        let ended = self
            .fail_in_place(live, &step, at, failure, StepFailure::EndsRun)
            .await;
        commit
            .report(ended, self.reported(live, &step))
            .await
            .expect("a failure that ends its run stores no output and an empty log")
            .expect("a settlement answers")
    }

    /// Deletes what the failed settlement of `step` wrote, records the failure, and answers the
    /// step's report at `at` failing as `failed_as` with the write's error.
    async fn fail_in_place(
        &self,
        live: &LiveRun,
        step: &WorkflowStepKey,
        at: WireInstant,
        failure: SettlementWriteFailure,
        failed_as: fn(Box<WorkflowStepError>) -> StepFailure,
    ) -> StepReport {
        let SettlementWriteFailure {
            error,
            artifact_ids,
        } = failure;
        for artifact_id in &artifact_ids {
            if let Err(removal) = self.payloads.delete(artifact_id).await {
                live.record
                    .fault(Some(step), EngineFault::TurnPayloadLeftBehind, &*removal)
                    .await;
            }
        }
        live.record
            .fault(Some(step), EngineFault::SettlementWriteFailed, &error)
            .await;
        StepReport {
            step: step.clone(),
            at,
            kind: StepReportKind::Settled(StepSettlement::Failed {
                failure: step_failure(live, step, failed_as, error.to_string()),
                log_lines: Vec::new(),
            }),
        }
    }

    /// Follows the settlement of `step` at `at`: a completion or a pass-on settles the walk and
    /// records the outputs, a retry readies the next attempt, a cancel drops the step. What
    /// follows a park, an end, a person wait or a spent account is the run's wave or wait, which
    /// keeps the step live, failed or waiting.
    async fn follow_settlement(
        &self,
        live: &mut LiveRun,
        turn: &mut RunTurn,
        step: &WorkflowStepKey,
        at: WireInstant,
        answer: SettlementAnswer,
    ) {
        match answer {
            SettlementAnswer::Completed {
                readying_event,
                outputs,
                run_variables,
            } => {
                let variables = Arc::make_mut(&mut live.run_variables);
                for (name, variable) in run_variables {
                    variables.insert(name, variable.value);
                }
                self.settle_step(live, turn, step, (readying_event, at), outputs)
                    .await;
            }
            SettlementAnswer::PassOn {
                readying_event,
                outputs,
            } => {
                self.settle_step(live, turn, step, (readying_event, at), outputs)
                    .await;
            }
            SettlementAnswer::Retry { wait: _ } => {
                let next = live.walk.retry(step);
                let failed = live
                    .steps
                    .remove(&step.execution_index.get())
                    .expect("a retried step is live");
                turn.commit.retried(&next, failed.input_ref.clone());
                turn.readied.push(TurnReadied {
                    ready: next,
                    inputs: failed.inputs,
                    input_ref: failed.input_ref,
                    next: ReadiedNext::Retry,
                });
            }
            SettlementAnswer::Canceled { readying_event } => {
                live.walk.drop_step(step);
                live.steps.remove(&step.execution_index.get());
                turn.last_readying_event = Some((readying_event, at));
            }
            SettlementAnswer::Park | SettlementAnswer::End => {
                live.move_step(step.execution_index.get(), WorkflowStepStatus::Failed, None);
            }
            SettlementAnswer::PersonWait { opened, .. } => {
                live.move_step(
                    step.execution_index.get(),
                    WorkflowStepStatus::Waiting,
                    Some(opened.cause),
                );
            }
            SettlementAnswer::AccountSpent { .. } => {
                let account = Some(WorkflowWaitCause::Account);
                live.move_step(
                    step.execution_index.get(),
                    WorkflowStepStatus::Waiting,
                    account,
                );
            }
        }
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
        let WalkTurn { ready, skipped, .. } = walked;
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
        for ready in ready {
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
            let (input_ref, next) = match self.store_input(live, &ready.step, &inputs).await {
                Ok(input_ref) => (input_ref, ReadiedNext::Dispatch),
                Err(message) => {
                    let failure = step_failure(live, &ready.step, StepFailure::Failed, message);
                    (
                        WorkflowPayloadRef::Inline { items: Vec::new() },
                        ReadiedNext::Fail(failed_at_once(&ready.step, failure)),
                    )
                }
            };
            turn.commit.readied(&ready, input_ref.clone(), event);
            turn.readied.push(TurnReadied {
                ready,
                inputs,
                input_ref,
                next,
            });
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
                    for dispatched in self.dispatch.dispatch(&live.scope, &snapshot, readied) {
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
