//! What the tick keeps of each run it drives between turns: the run's walk, what its steps
//! recorded, each of its steps still to settle with what its failure route reads and how it is
//! stopped, the waves of its steps winding down, how a failure stopped it, the approval asks
//! waiting on their pause points, and what reached the run while it paused.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Map, Value};
use sidekicks_contracts::wire::id::UuidTextForm;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::run::snapshot::WorkflowRunEpoch;
use sidekicks_contracts::workflow::run::status::{WorkflowStepStatus, WorkflowWaitCause};
use sidekicks_contracts::workflow::run::step::record::{
    WorkflowPayloadRef, WorkflowStepKey, WorkflowStepSource,
};

use tokio_util::sync::CancellationToken;

use super::branch_cancellation::BranchWave;
use super::commit::{RunEnding, RunLiveStep};
use super::run_status::{RunPersonWait, RunStepCounts};
use super::step_failure::RunStop;
use super::turns::{RunCancelIntake, RunCancelReply};
use super::walk::{RunGraph, RunWalk, WalkReady};
use super::{ParkedAgentRun, RunScope, StepReport};
use crate::engine::deadlines::EngineDeadlines;
use crate::engine::event_record::{EngineDeadline, EngineDecision, RunEngineRecord};
use crate::engine::ports::StepAdmissionTicket;
use crate::engine::waits::OpenedPersonWait;
use crate::engine::waits::answers::PersonWaitIntake;
use crate::expressions::lineage::StepOutputs;
use crate::kinds::PersonAsk;
use crate::runs::gate_resolution::RunEventKeys;

/// A run the tick drives: its scope, its record, its walk, each node's executions so far, the
/// values it set with `Set variables`, its steps still to settle, the reports its last dispatch
/// answered, which open its next turn, its step counts and person-wait columns as its last write
/// left them, the waves of its steps winding down, how a failure stopped it and the ending it
/// decided, and its approval pauses.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct LiveRun {
    /// What the run's steps share.
    pub(crate) scope: Arc<RunScope>,
    /// The run's record in the engine's record.
    pub(crate) record: RunEngineRecord,
    /// The run's walk over its pinned version's graph.
    pub(crate) walk: RunWalk,
    /// Each node's executions so far, which a dispatched step's expressions read.
    pub(crate) outputs: StepOutputs,
    /// The values the run set with `Set variables`, shared with each snapshot that reads them.
    pub(crate) run_variables: Arc<Map<String, Value>>,
    /// The run's steps readied and not yet settled, by execution index, which no two steps of a
    /// run share.
    pub(crate) steps: HashMap<u64, LiveStep>,
    /// The reports the run's last dispatch answered, which the run's next turn writes before any
    /// report its drivers sent.
    pub(crate) next_batch: Vec<StepReport>,
    /// The run's step counts, which each turn's commit moves and answers.
    pub(crate) counts: RunStepCounts,
    /// The run's person-wait columns, which each turn's commit moves and answers.
    pub(crate) person_wait: RunPersonWait,
    /// The waves of the run's steps winding down, each settling together once its last member
    /// has settled.
    pub(crate) waves: Vec<BranchWave>,
    /// How a failure stopped the run, where one did: a stopped run starts nothing new.
    pub(crate) stop: Option<RunStop>,
    /// The ending a stop decided, written once none of the run's steps runs, is held, pending or
    /// waiting.
    pub(crate) ending: Option<RunEnding>,
    /// The replies to the person's cancels of the run, sent once the write of its ending commits.
    pub(crate) cancel_replies: Vec<RunCancelReply>,
    /// Whether the run's turn armed or cleared a person wait's deadline, a parked step's resume or
    /// the run's cap, or took a late answer, so the deadline clock is read again once the turn's
    /// write commits.
    pub(crate) needs_deadline_read: bool,
    /// The deadline arm and clear lines of the run's turn, each on its step or, for the run's
    /// cap, on none, recorded once its write commits.
    pub(crate) deadline_lines: Vec<(Option<WorkflowStepKey>, EngineDecision<'static>)>,
    /// The run's cap deadline as its last line armed it, `None` while none is armed.
    pub(crate) cap_at: Option<WireInstant>,
    /// The run's current execution, 0 for its first.
    pub(crate) epoch: WorkflowRunEpoch,
    /// The approval pauses the run's current execution has taken, so its next pause is this count
    /// and 1.
    pub(crate) approval_pauses: u64,
    /// The approval asks of the run's pause, each waiting on its point; all are asked once the
    /// last of their points ends.
    pub(crate) pausing: Vec<TurnAsk>,
    /// What reached the run while it paused, taken by the turn its last pause point's end opens.
    pub(crate) held: HeldTurn,
}

/// What reached a pausing run, kept for the turn its last pause point's end opens, each list in
/// arrival order.
pub(crate) struct HeldTurn {
    /// The answers routed to the run, unreplied.
    pub(crate) answers: Vec<PersonWaitIntake>,
    /// The reports of the run's steps.
    pub(crate) reports: Vec<StepReport>,
    /// The steps ready to dispatch: retries come due, and steps its pause's own turn readied.
    pub(crate) dispatches: Vec<WorkflowStepKey>,
    /// The person's cancels of the run, taken once the capture under way ends.
    pub(crate) cancels: Vec<RunCancelIntake>,
}

/// A person wait a turn opened, asked once the turn's write commits: its step, the wait, what the
/// person is asked, the step's place at the memory gate, dropped once the ask returns, and whether
/// an approval's pause point has ended, so the ask raises its card.
pub(crate) struct TurnAsk {
    /// The step that waits.
    pub(crate) step: WorkflowStepKey,
    /// The wait the turn opened.
    pub(crate) opened: OpenedPersonWait,
    /// What the person is asked.
    pub(crate) ask: PersonAsk,
    /// The step's place at the memory gate, held until the ask returns.
    pub(crate) admission: Option<Arc<dyn StepAdmissionTicket>>,
    /// Whether the approval's pause point has ended, always `false` for a form or a reply.
    pub(crate) is_point_taken: bool,
}

/// A step of a live run readied and not yet settled: what its failure route and its next attempt
/// read, where it stands, which its next report moves the run's counts from, its place at the
/// memory gate, and how it is stopped.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct LiveStep {
    /// The step.
    pub(crate) step: WorkflowStepKey,
    /// Its loop's run index, which its dispatch reads.
    pub(crate) run_index: u64,
    /// Where it stands.
    pub(crate) status: WorkflowStepStatus,
    /// What it waits on, while it is `waiting`.
    pub(crate) wait_cause: Option<WorkflowWaitCause>,
    /// The id of the person wait it waits on, which an answer names.
    pub(crate) wait_id: Option<UuidTextForm>,
    /// When its person wait gives up, where the wait has a deadline.
    pub(crate) wait_deadline_at: Option<WireInstant>,
    /// The feed of each main input slot in slot order.
    pub(crate) sources: Vec<Option<WorkflowStepSource>>,
    /// The input lists, one per input handle of its kind's spec.
    pub(crate) inputs: Vec<Vec<WorkflowItem>>,
    /// The input as its `pending` row stores it.
    pub(crate) input_ref: WorkflowPayloadRef,
    /// The sequence of the event whose write readied it.
    pub(crate) readying_sequence: SafeInt<0>,
    /// The instant of its hold's last report, `Some` only while the memory gate holds it.
    pub(crate) last_hold_report_at: Option<WireInstant>,
    /// Its dispatch's cancel, `None` until it is dispatched.
    pub(crate) cancel: Option<CancellationToken>,
    /// Whether it was asked to stop and is winding down.
    pub(crate) is_winding_down: bool,
    /// The agent run it waits on while its account is spent, kept for the account's resume and
    /// stopped when the step is canceled.
    pub(crate) parked_agent_run: Option<ParkedAgentRun>,
    /// When it resumes itself from its spent account's wait, where a resume is armed.
    pub(crate) resume_at: Option<WireInstant>,
}

impl LiveStep {
    /// The step `ready`, `pending` and undispatched, on `inputs`, stored as `input_ref`, readied by
    /// the write of the event at `readying_sequence`.
    pub(crate) fn readied(
        ready: WalkReady,
        inputs: Vec<Vec<WorkflowItem>>,
        input_ref: WorkflowPayloadRef,
        readying_sequence: SafeInt<0>,
    ) -> Self {
        Self {
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
            resume_at: None,
        }
    }
}

impl LiveRun {
    /// The run of `scope` before any step, walking `graph` and recording through `record`.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn new(scope: Arc<RunScope>, graph: Arc<RunGraph>, record: RunEngineRecord) -> Self {
        let outputs = StepOutputs::new(
            scope
                .nodes
                .values()
                .map(|node| (node.id.clone(), node.name.as_str().to_owned())),
        );
        Self {
            walk: RunWalk::new(graph, scope.run_id),
            scope,
            record,
            outputs,
            run_variables: Arc::new(Map::new()),
            steps: HashMap::new(),
            next_batch: Vec::new(),
            counts: RunStepCounts::default(),
            person_wait: RunPersonWait::default(),
            waves: Vec::new(),
            stop: None,
            ending: None,
            cancel_replies: Vec::new(),
            needs_deadline_read: false,
            deadline_lines: Vec::new(),
            cap_at: None,
            epoch: WorkflowRunEpoch(SafeInt::ZERO),
            approval_pauses: 0,
            pausing: Vec::new(),
            held: HeldTurn {
                answers: Vec::new(),
                reports: Vec::new(),
                dispatches: Vec::new(),
                cancels: Vec::new(),
            },
        }
    }

    /// Whether any ask of the run's pause still waits on its point: a pausing run takes no turn.
    pub(crate) fn is_pausing(&self) -> bool {
        self.pausing.iter().any(|turn_ask| !turn_ask.is_point_taken)
    }

    /// Moves the live step at `execution_index` to `status`, waiting on `wait_cause` where it
    /// waits, as the turn's commit moved its row; the step leaves any wait it held, whose deadline
    /// or armed resume is cleared.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn move_step(
        &mut self,
        execution_index: u64,
        status: WorkflowStepStatus,
        wait_cause: Option<WorkflowWaitCause>,
    ) {
        let live_step = self
            .steps
            .get_mut(&execution_index)
            .expect("a step the turn moved is live");
        live_step.status = status;
        live_step.wait_cause = wait_cause;
        let cleared = leave_wait(live_step);
        self.clear_deadline(cleared);
    }

    /// Moves the live step at `execution_index` to `waiting` on the person wait `opened`, as the
    /// turn's commit stored it, its deadline armed where it has one.
    pub(crate) fn wait_on_person(&mut self, execution_index: u64, opened: &OpenedPersonWait) {
        self.move_step(
            execution_index,
            WorkflowStepStatus::Waiting,
            Some(opened.cause),
        );
        let live_step = self
            .steps
            .get_mut(&execution_index)
            .expect("a step the turn moved is live");
        live_step.wait_id = Some(opened.wait_id);
        live_step.wait_deadline_at.clone_from(&opened.deadline_at);
        if let Some(deadline_at) = &opened.deadline_at {
            let armed = EngineDecision::DeadlineArmed {
                deadline: EngineDeadline::Wait {
                    wait_id: opened.wait_id,
                },
                at: deadline_at.clone(),
            };
            self.deadline_lines
                .push((Some(live_step.step.clone()), armed));
            self.needs_deadline_read = true;
        }
    }

    /// Moves the run's cap to where `deadlines` puts it now, or clears it once `is_ended`: a cap
    /// that moved clears its old line and arms its new one, and queues the clock's read.
    pub(crate) fn follow_cap(&mut self, deadlines: &EngineDeadlines, is_ended: bool) {
        let cap_at = if is_ended {
            None
        } else {
            deadlines.cap_deadline(self.scope.run_started_at, &self.person_wait)
        };
        if cap_at == self.cap_at {
            return;
        }
        if let Some(at) = self.cap_at.take() {
            let cleared = EngineDecision::DeadlineCleared {
                deadline: EngineDeadline::Cap,
                at,
            };
            self.deadline_lines.push((None, cleared));
        }
        if let Some(at) = cap_at.clone() {
            let armed = EngineDecision::DeadlineArmed {
                deadline: EngineDeadline::Cap,
                at,
            };
            self.deadline_lines.push((None, armed));
        }
        self.cap_at = cap_at;
        self.needs_deadline_read = true;
    }

    /// Moves the live step at `execution_index` to `waiting` on its spent account, as the turn's
    /// commit stored it, keeping its agent `run` for the resume and arming its `resume_at` where
    /// one is set.
    pub(crate) fn wait_on_account(
        &mut self,
        execution_index: u64,
        parked: ParkedAgentRun,
        resume_at: Option<WireInstant>,
    ) {
        self.move_step(
            execution_index,
            WorkflowStepStatus::Waiting,
            Some(WorkflowWaitCause::Account),
        );
        let live_step = self
            .steps
            .get_mut(&execution_index)
            .expect("a step the turn moved is live");
        live_step.parked_agent_run = Some(parked);
        live_step.resume_at.clone_from(&resume_at);
        if let Some(at) = resume_at {
            let armed = EngineDecision::DeadlineArmed {
                deadline: EngineDeadline::ResumeAt,
                at,
            };
            self.deadline_lines
                .push((Some(live_step.step.clone()), armed));
            self.needs_deadline_read = true;
        }
    }

    /// Takes the live step at `execution_index` out of the run, `None` where none is live; the
    /// step leaves any person wait it held, whose deadline is cleared.
    pub(crate) fn remove_step(&mut self, execution_index: u64) -> Option<LiveStep> {
        let mut removed = self.steps.remove(&execution_index)?;
        let cleared = leave_wait(&mut removed);
        self.clear_deadline(cleared);
        Some(removed)
    }

    // Queues the clear line of a deadline a step left, where it held one.
    fn clear_deadline(&mut self, cleared: Option<(WorkflowStepKey, EngineDecision<'static>)>) {
        if let Some((step, line)) = cleared {
            self.deadline_lines.push((Some(step), line));
            self.needs_deadline_read = true;
        }
    }

    /// The session, definition and version the run's events name.
    pub(crate) fn event_keys(&self) -> RunEventKeys {
        RunEventKeys {
            session_id: self.scope.session_id,
            definition_id: self.scope.workflow_id,
            workflow_version_id: self.scope.workflow_version_id,
        }
    }

    /// The run's live steps as a resumption point reads them.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
    pub(crate) fn live_steps(&self) -> impl Iterator<Item = RunLiveStep<'_>> {
        self.steps.values().map(|live_step| RunLiveStep {
            step: &live_step.step,
            status: live_step.status,
            wait_cause: live_step.wait_cause,
        })
    }
}

// Takes `live_step` out of its wait, answering the clear line of the person wait's deadline or
// the account wait's armed resume it held.
fn leave_wait(live_step: &mut LiveStep) -> Option<(WorkflowStepKey, EngineDecision<'static>)> {
    let wait_id = live_step.wait_id.take();
    let deadline_at = live_step.wait_deadline_at.take();
    let resume_at = live_step.resume_at.take();
    let (deadline, at) = match (wait_id, deadline_at, resume_at) {
        (Some(wait_id), Some(at), _) => (EngineDeadline::Wait { wait_id }, at),
        (_, _, Some(at)) => (EngineDeadline::ResumeAt, at),
        _ => return None,
    };
    let cleared = EngineDecision::DeadlineCleared { deadline, at };
    Some((live_step.step.clone(), cleared))
}
