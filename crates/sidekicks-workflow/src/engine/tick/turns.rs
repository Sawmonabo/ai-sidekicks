//! The tick's loop: one task for the whole engine over the one dispatch every run's steps go
//! through, so the memory gate's line keeps ready order across runs. Each turn takes what arrived,
//! commits each run's share in one write, walks what committed and dispatches what the walk
//! readied.

mod committing;
mod dispatching;
mod ending;
mod inbox;
mod readying;
mod reports;
mod restart;
mod resuming;
mod retries;
mod starting;

#[cfg(test)]
mod tests;

pub(crate) use ending::{RunCancelIntake, RunCancelRefusal, RunCancelReply};
pub(crate) use resuming::{RepinReadError, RepinRefusal, RunResumeIntake, RunResumeRefusal};

use std::collections::{HashMap, HashSet, VecDeque};
use std::error::Error;
use std::sync::Arc;
use std::time::Duration;

use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::UuidTextForm;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::definition::document::{WorkflowNode, WorkflowVersionId};
use sidekicks_contracts::workflow::definition::item::{WorkflowItem, WorkflowStepError};
use sidekicks_contracts::workflow::kind::WorkflowNodeKindSpec;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::snapshot::{WorkflowRunEpoch, WorkflowRunPauseNumber};
use sidekicks_contracts::workflow::run::status::WorkflowStepStatus;
use sidekicks_contracts::workflow::run::step::record::{WorkflowPayloadRef, WorkflowStepKey};
use sidekicks_std::scheduler::armed_instant::InstantJob as _;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::events::log_service::EventLogService;
use sidekicks_store::events::session::appender::SessionEventAppender;
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;
use sidekicks_workspace::run_setup_gates::execution_root::context::SessionRunBinder;
use tokio::sync::mpsc::error::TryRecvError;
use tokio::sync::{mpsc, oneshot};
use tokio::task::{Id, JoinError, JoinSet};

use self::retries::retry_due;
use super::commit::{ReportedStep, RunTurnCommit};
use super::dispatch::{StepDispatch, fill_step_failure};
use super::live_runs::{LiveRun, LiveStep, TurnAsk};
use super::walk::{WalkReady, WalkTurn};
use super::{ParkedAgentRun, ReadyStep, StepReport, StepReportKind, StepSettlement};
use crate::engine::chain::KeepGoingIntake;
use crate::engine::deadlines::EngineDeadlines;
use crate::engine::event_record::{EngineFault, EngineRecorder, RunEngineRecord};
use crate::engine::ports::{PortError, RunSnapshotPoints, StepAdmission, StepPayloadArtifacts};
use crate::engine::start::{ReloadedRun, StartedRun};
use crate::engine::waits::answers::PersonWaitIntake;
use crate::engine::waits::{PersonWaitPorts, PersonWaitRefusal};
use crate::kinds::{NodeKindTable, StepFailure, uncoded_step_error};

use self::starting::RunOpening;

/// The most reports one turn takes, and the most inputs from its inbox, so a turn stays bounded.
const TURN_REPORT_LIMIT: usize = 256;

/// The statements the tick prepares on a read connection: the workflow's level, a chain's held
/// steps and its question, which Keep going reads, and a re-pin's reads.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) const ENGINE_TICK_STATEMENT_CAPACITY: usize = 3 + resuming::REPIN_STATEMENT_CAPACITY;

// Why the kinds table lists every node of a live run.
const KIND_CHECKED: &str = "the start checked that the table lists every node's kind";

/// What reaches the tick from outside its own steps.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) enum EngineTickInput {
    /// A run the start wrote, which the tick walks from its trigger step, or a node run from the
    /// earlier steps it reuses.
    Started(StartedRun),
    /// A person's answer to a step waiting on them.
    Answer(PersonWaitIntake),
    /// A `Keep going` of a chain whose question waits.
    KeepGoing(KeepGoingIntake),
    /// A person's cancel of a run.
    Cancel(RunCancelIntake),
    /// A person's Resume of a run.
    Resume(RunResumeIntake),
    /// `Stop a run after` changed: every live run's cap follows it before the clock is read
    /// again.
    RunLimitChanged,
    /// The unfinished runs recovery rebuilt for a session settled after the engine started, taken
    /// back as the start's are, each run's sweep written in this turn.
    TakeBack(Vec<ReloadedRun>),
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
    /// The engine's deadline clock, read again after a write moves a deadline.
    pub(crate) deadlines: Arc<EngineDeadlines>,
    /// The snapshot points a run takes, each on its own task.
    pub(crate) snapshot_points: Arc<dyn RunSnapshotPoints>,
    /// Told once a run's ending, which releases its execution context, commits.
    pub(crate) binder: Arc<dyn SessionRunBinder>,
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
    deadlines: Arc<EngineDeadlines>,
    snapshot_points: Arc<dyn RunSnapshotPoints>,
    binder: Arc<dyn SessionRunBinder>,
    /// Whether this turn's writes armed or cleared a person wait's deadline, a parked step's resume
    /// or a run's cap, took a late answer, dropped a run or the run limit changed, so the deadline
    /// clock is read again at the turn's end.
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
    /// One task per approval pause whose point is being taken, answering the capture's end.
    pause_points: JoinSet<Result<(), PortError>>,
    /// The pause point of each of those tasks, by the task's id, so a task that panics still
    /// routes to its ask.
    pause_point_tasks: HashMap<Id, PausePoint>,
    /// One task per ended run's sweep out of a tree removed while it worked there, reaped each
    /// turn and waited for once the inbox closes.
    released_sweeps: JoinSet<()>,
}

/// An approval pause's point: its run, the wait whose card follows it, the run's execution it
/// belongs to, and which of that execution's pauses it is.
struct PausePoint {
    run_id: WorkflowRunId,
    wait_id: UuidTextForm,
    epoch: WorkflowRunEpoch,
    pause_number: WorkflowRunPauseNumber,
}

/// One run's share of a turn while it is gathered: its write, what it readied, the reports its
/// cancels queued to apply next, the last event whose write readies steps, the person waits it
/// opened, and the replies to the answers it settled.
struct RunTurn {
    commit: RunTurnCommit,
    readied: Vec<TurnReadied>,
    /// The approvals of a pause whose last point ended, then the person waits the turn opened,
    /// asked once its write commits.
    asks: Vec<TurnAsk>,
    /// The replies to the answers the turn settled, sent once its write commits.
    replies: Vec<oneshot::Sender<Result<(), PersonWaitRefusal>>>,
    /// The reports a cancel or a closed wave queued, applied in order after the report that
    /// queued them, so nothing recurses.
    follow_ups: VecDeque<StepReport>,
    /// The steps the turn resumed from a spent account, each with its kept agent run, taken
    /// again once the write commits.
    resumes: Vec<(WorkflowStepKey, ParkedAgentRun)>,
    /// The replies to the person's Resumes the turn took, each with the version a re-pin moved the
    /// run from, sent once its write commits.
    resume_replies: Vec<(resuming::RunResumeReply, Option<WorkflowVersionId>)>,
    /// The index and instant of the turn's last event that carries readied steps.
    last_readying_event: Option<(usize, WireInstant)>,
}

/// What reached one run for a turn: the answers routed to it, its steps' reports, its retries come
/// due, its pause points ended, the person's Resumes and cancels and, for a node run starting,
/// its walk's first turn.
struct RunArrivals {
    answers: Vec<PersonWaitIntake>,
    reports: Vec<StepReport>,
    due: Vec<WorkflowStepKey>,
    taken: Vec<PausePoint>,
    resumes: Vec<RunResumeIntake>,
    cancels: Vec<RunCancelIntake>,
    seed: Option<WalkTurn>,
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
            snapshot_points,
            binder,
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
            snapshot_points,
            binder,
            needs_deadline_read: false,
            dropped_waits: HashSet::new(),
            runs: HashMap::new(),
            batched: Vec::new(),
            retries: JoinSet::new(),
            pause_points: JoinSet::new(),
            pause_point_tasks: HashMap::new(),
            released_sweeps: JoinSet::new(),
        }
    }

    /// Runs turns until the inbox closes: waits for a report, a retry come due, a pause point's end
    /// or an input unless a run holds a next batch, takes what is queued up to the turn's bound,
    /// every retry come due and every point ended, reaps each ended run's sweep, and runs the turn.
    /// Once the inbox closes, it waits for every pending point to end, raising no card, so no
    /// capture is cut short, and for every run's sweep under way.
    pub(crate) async fn run(mut self) {
        let mut reports = Vec::with_capacity(TURN_REPORT_LIMIT);
        let mut inputs = Vec::new();
        let mut due = Vec::new();
        let mut ended = Vec::new();
        'turns: loop {
            // A pinned step or an at-once failure has no driver to wake the loop.
            if self.batched.is_empty() {
                tokio::select! {
                    _ = self.reports.recv_many(&mut reports, TURN_REPORT_LIMIT) => {}
                    Some(timer) = self.retries.join_next(), if !self.retries.is_empty() => {
                        due.extend(retry_due(timer));
                    }
                    Some(point) = self.pause_points.join_next_with_id(),
                        if !self.pause_points.is_empty() => ended.push(point),
                    input = self.inbox.recv() => match input {
                        Some(input) => inputs.push(input),
                        None => break 'turns,
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
                    Err(TryRecvError::Disconnected) => break 'turns,
                }
            }
            while let Some(timer) = self.retries.try_join_next() {
                due.extend(retry_due(timer));
            }
            while let Some(point) = self.pause_points.try_join_next_with_id() {
                ended.push(point);
            }
            while let Some(swept) = self.released_sweeps.try_join_next() {
                released_run_swept(swept);
            }
            let taken = ended
                .drain(..)
                .map(|point| self.pause_point_taken(point))
                .collect();
            self.turn(
                std::mem::take(&mut inputs),
                std::mem::take(&mut reports),
                std::mem::take(&mut due),
                taken,
            )
            .await;
        }
        for point in ended {
            self.pause_point_taken(point);
        }
        while let Some(point) = self.pause_points.join_next_with_id().await {
            self.pause_point_taken(point);
        }
        while let Some(swept) = self.released_sweeps.join_next().await {
            released_run_swept(swept);
        }
    }

    /// The pause point whose task `ended`, its task's entry removed; a capture that failed, or
    /// whose task panicked, is logged at warn, and its card is still raised.
    fn pause_point_taken(
        &mut self,
        ended: Result<(Id, Result<(), PortError>), JoinError>,
    ) -> PausePoint {
        let (task_id, taken) = match ended {
            Ok(ended) => ended,
            Err(error) => (error.id(), Err(error.into())),
        };
        let point = self
            .pause_point_tasks
            .remove(&task_id)
            .expect("each pause point's task is kept by its id");
        if let Err(error) = taken {
            tracing::warn!(
                workflow_run_id = %point.run_id,
                epoch = point.epoch.0.get(),
                pause_number = point.pause_number.0.get(),
                error = &*error as &(dyn Error + 'static),
                "a workflow run's pause point could not be taken"
            );
        }
        point
    }

    /// One turn: each `Keep going` as its own write while the inputs are routed, each Resume routed
    /// as it arrives and each cancel after every run the batch starts, then each run's share in
    /// arrival order, a starting node run's seeded first turn first, then its next batch, then the
    /// answers routed to it, and its retries come `due` and its pause points `taken` with it,
    /// committed in one write per run; then one read of the dispatching runs' levels, their
    /// dispatch, one read of the deadline clock where a write moved a deadline, and one weigh of
    /// the memory gate. A run whose pause point is still pending sits the turn out, keeping what
    /// reached it.
    async fn turn(
        &mut self,
        inputs: Vec<EngineTickInput>,
        reports: Vec<StepReport>,
        due: Vec<WorkflowStepKey>,
        taken: Vec<PausePoint>,
    ) {
        let mut order = std::mem::take(&mut self.batched);
        let mut dispatching: Vec<(WorkflowRunId, Vec<ReadyStep>)> = Vec::new();
        let mut answers: HashMap<WorkflowRunId, Vec<PersonWaitIntake>> = HashMap::new();
        let mut cancels: HashMap<WorkflowRunId, Vec<RunCancelIntake>> = HashMap::new();
        let mut resumes: HashMap<WorkflowRunId, Vec<RunResumeIntake>> = HashMap::new();
        let mut seeds: HashMap<WorkflowRunId, WalkTurn> = HashMap::new();
        // A start's row is visible to a cancel before the tick holds its run.
        let mut cancel_intakes = Vec::new();
        for input in inputs {
            match input {
                EngineTickInput::Started(run) => match self.start_run(run) {
                    (run_id, RunOpening::Readied(ready)) => dispatching.push((run_id, vec![ready])),
                    (run_id, RunOpening::Seeded(seed)) => {
                        order.push(run_id);
                        seeds.insert(run_id, seed);
                    }
                },
                EngineTickInput::Answer(intake) => {
                    self.route_answer(intake, &mut order, &mut answers);
                }
                EngineTickInput::KeepGoing(intake) => self.keep_going(intake).await,
                EngineTickInput::Cancel(intake) => cancel_intakes.push(intake),
                EngineTickInput::Resume(intake) => {
                    if let Some(unheld) =
                        self.route_control(intake.run_id, intake, &mut order, &mut resumes)
                    {
                        let _unheard = unheld.reply.send(Err(RunResumeRefusal::NotHeld));
                    }
                }
                EngineTickInput::RunLimitChanged => self.follow_run_limit().await,
                EngineTickInput::TakeBack(runs) => {
                    self.restart(runs).await;
                    for run_id in std::mem::take(&mut self.batched) {
                        if !order.contains(&run_id) {
                            order.push(run_id);
                        }
                    }
                }
            }
        }
        for intake in cancel_intakes {
            if let Some(unheld) =
                self.route_control(intake.run_id, intake, &mut order, &mut cancels)
            {
                let _unheard = unheld.reply.send(Err(RunCancelRefusal::NotHeld));
            }
        }
        let mut arrived = by_run(&mut order, reports, |report| report.step.workflow_run_id);
        let mut due_by_run = by_run(&mut order, due, |step| step.workflow_run_id);
        let mut taken_by_run = by_run(&mut order, taken, |point| point.run_id);
        for run_id in order {
            let arrived = RunArrivals {
                answers: answers.remove(&run_id).unwrap_or_default(),
                reports: arrived.remove(&run_id).unwrap_or_default(),
                due: due_by_run.remove(&run_id).unwrap_or_default(),
                taken: taken_by_run.remove(&run_id).unwrap_or_default(),
                resumes: resumes.remove(&run_id).unwrap_or_default(),
                cancels: cancels.remove(&run_id).unwrap_or_default(),
                seed: seeds.remove(&run_id),
            };
            if let Some(readied) = self.run_turn(run_id, arrived).await
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

    /// Routes `intake`, a person's control of the run `run_id`, to that run's share of the turn,
    /// the run added to `order` where it is not there yet; hands `intake` back where the tick does
    /// not hold the run.
    fn route_control<Intake>(
        &self,
        run_id: WorkflowRunId,
        intake: Intake,
        order: &mut Vec<WorkflowRunId>,
        routed: &mut HashMap<WorkflowRunId, Vec<Intake>>,
    ) -> Option<Intake> {
        if !self.runs.contains_key(&run_id) {
            return Some(intake);
        }
        if !order.contains(&run_id) {
            order.push(run_id);
        }
        routed.entry(run_id).or_default().push(intake);
        None
    }

    /// Moves every live run's cap to `Stop a run after` as set now, recording each cap line that
    /// moved, and queues the clock's read.
    async fn follow_run_limit(&mut self) {
        for live in self.runs.values_mut() {
            live.follow_cap(&self.deadlines, false);
            for (step, line) in std::mem::take(&mut live.deadline_lines) {
                live.record.decision(step.as_ref(), line).await;
            }
            self.needs_deadline_read |= std::mem::take(&mut live.needs_deadline_read);
        }
        // The clock reads every unfinished run's cap under the new limit, live or not.
        self.needs_deadline_read = true;
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

/// Sweeps `session_id` out of a tree removed while its ended run worked there, on a task of its
/// own in `sweeps` so no turn waits on it, a failure recorded on the run's `record` as a fault.
fn sweep_released_run(
    sweeps: &mut JoinSet<()>,
    binder: Arc<dyn SessionRunBinder>,
    session_id: SessionId,
    record: RunEngineRecord,
) {
    sweeps.spawn(async move {
        if let Err(error) = binder.sweep_released_run(session_id).await {
            record
                .fault(None, EngineFault::RemovedTreeSweepFailed, &error)
                .await;
        }
    });
}

/// Logs at warn a run's sweep whose task panicked; its own failure is on the run's record.
fn released_run_swept(swept: Result<(), JoinError>) {
    if let Err(error) = swept {
        tracing::warn!(
            error = &error as &(dyn Error + 'static),
            "an ended workflow run's tree sweep did not finish"
        );
    }
}

/// `items` grouped by the run `run_of` names, each run added to `order` where it is not there yet.
fn by_run<T>(
    order: &mut Vec<WorkflowRunId>,
    items: Vec<T>,
    run_of: fn(&T) -> WorkflowRunId,
) -> HashMap<WorkflowRunId, Vec<T>> {
    let mut grouped: HashMap<WorkflowRunId, Vec<T>> = HashMap::new();
    for item in items {
        let run_id = run_of(&item);
        if !order.contains(&run_id) {
            order.push(run_id);
        }
        grouped.entry(run_id).or_default().push(item);
    }
    grouped
}

/// `step` of `live` to dispatch while it is still live and undispatched, as a retry come due, a
/// dispatch a pause held or a step the restart takes back; `None` once it settled, was canceled or
/// was dispatched.
fn still_ready(live: &LiveRun, step: WorkflowStepKey) -> Option<ReadyStep> {
    let index = step.execution_index.get();
    let live_step = live.steps.get(&index)?;
    is_undispatched(live_step).then(|| ReadyStep {
        step,
        run_index: live_step.run_index,
        inputs: live_step.inputs.clone(),
        input_ref: live_step.input_ref.clone(),
        is_taken_back: live.taken_back.contains(&index),
    })
}

/// Whether `live_step` is still undispatched, `pending` or held by the memory gate of the restart's
/// sweep, so the turn may dispatch it.
fn is_undispatched(live_step: &LiveStep) -> bool {
    matches!(
        live_step.status,
        WorkflowStepStatus::Pending | WorkflowStepStatus::WaitingMemory
    ) && live_step.cancel.is_none()
}
