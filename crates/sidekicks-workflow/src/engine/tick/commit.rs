//! One run's turn as the event log keeps it: what the run's steps reported and what the walk
//! decided, turned into the run's events and row changes and committed in one append, each event
//! at the instant its report was made, so the live rows and the fold read one instant.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use sidekicks_contracts::approval::ApprovalDecision;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_contracts::workflow::definition::document::{WorkflowNode, WorkflowNodeId};
use sidekicks_contracts::workflow::definition::item::{WorkflowItem, WorkflowStepError};
use sidekicks_contracts::workflow::kind::WorkflowNodeKindSpec;
use sidekicks_contracts::workflow::run::control::WorkflowCancelReason;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::snapshot::WorkflowRunEpoch;
use sidekicks_contracts::workflow::run::status::{WorkflowStepStatus, WorkflowWaitCause};
use sidekicks_contracts::workflow::run::step::events::{
    WorkflowParallelJoinBranchesCanceledPayload, WorkflowPhaseAdmittedPayload,
    WorkflowPhaseCancelingPayload, WorkflowPhaseProgressedPayload, WorkflowPhaseRetriedPayload,
    WorkflowPhaseStartedPayload, WorkflowPhaseWaitingOnPoolPayload, WorkflowReadiedStep,
    WorkflowStepSkipReason, WorkflowStepSkippedPayload, WorkflowStepStartedPayload,
};
use sidekicks_contracts::workflow::run::step::record::{WorkflowPayloadRef, WorkflowStepKey};
use sidekicks_store::database::statement::WriteStatement;
use sidekicks_store::events::session::appender::SessionEventEmitError;

use super::run_status::{
    GoingRunStatus, RunPersonWait, RunStepCounts, going_run_status, whole_milliseconds_between,
};
use super::walk::{WalkReady, WalkSkip, WalkSkipReason};
use super::{BranchCancelReason, ParkedAgentRun, StepReport, StepReportKind};
use crate::definitions::kept_values::KeptArtifactReads;
use crate::engine::event_record::{EngineDecision, StepEnding, StepTransition};
use crate::engine::ports::{StepAdmissionTicket, StepPayloadArtifacts};
use crate::engine::waits::OpenedPersonWait;
use crate::kinds::step_context::StepRunVariable;
use crate::kinds::{PersonAsk, StepFailure};
use crate::runs::gate_resolution::RunEventKeys;
use crate::runs::step_payload::StepPayloadWriteError;
use crate::runs::step_rows::{
    add_step_pool_wait, admit_step, hold_step, insert_pending_step, insert_skipped_step,
    record_step_start,
};

/// A step event's payload: the step `$step` names in `$session_id`, then `$member`s.
macro_rules! step_payload {
    ($payload:ident, $session_id:expr, $step:expr $(, $member:ident: $value:expr)* $(,)?) => {
        $payload {
            session_id: $session_id,
            workflow_run_id: $step.workflow_run_id,
            node_id: $step.node_id.clone(),
            attempt: $step.attempt,
            execution_index: $step.execution_index,
            $($member: $value,)*
        }
    };
}

/// A run event's payload: the run `$run_id` with the session, definition and version `$keys`
/// name, then `$member`s.
macro_rules! run_payload {
    ($payload:ident, $keys:expr, $run_id:expr $(, $member:ident: $value:expr)* $(,)?) => {
        $payload {
            session_id: $keys.session_id,
            workflow_run_id: $run_id,
            definition_id: $keys.definition_id,
            workflow_version_id: $keys.workflow_version_id,
            $($member: $value,)*
        }
    };
}

mod run_events;
mod settlement;
mod write;

pub(crate) use run_events::RunLiveStep;

/// One run's events and row statements for this turn, in the order handed: each event typed,
/// with its instant, until the append drafts it, since a readied step adds to an event held.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct RunTurnCommit {
    /// The run's session, whose log takes the write, its definition and the version it pins.
    keys: RunEventKeys,
    /// The run.
    run_id: WorkflowRunId,
    /// The run's execution, which its `workflow.run.resumed` carries.
    epoch: WorkflowRunEpoch,
    /// The index of the `workflow.run.resumed` a person's Resume wrote, which the steps it runs
    /// again ride and which takes the turn's status move in place of a second.
    resumed_event: Option<usize>,
    /// The run's step counts, moved by each change the turn makes to a step.
    counts: RunStepCounts,
    /// The run's status as the turn found it.
    status_before: GoingRunStatus,
    /// The run's person-wait columns as the turn found them.
    person_wait: RunPersonWait,
    /// The store of a payload above the inline cap, written before the append.
    payloads: Arc<dyn StepPayloadArtifacts>,
    /// The turn's events, in write order.
    events: Vec<TurnEvent>,
    /// The turn's row statements, in the order handed.
    statements: Vec<WriteStatement>,
    /// Each step whose `pending` row this turn writes, beside the index of the event it rides.
    pending: Vec<(WorkflowStepKey, usize)>,
    /// Each artifact a payload ref this turn stores names, which a failed write leaves unnamed.
    artifact_ids: Vec<ArtifactId>,
    /// Where among `statements` the committed write names the kept-value artifacts no row names
    /// once it commits.
    kept_reads: KeptArtifactReads,
    /// Each applied report that moved its step, recorded once the write commits.
    moves: Vec<(WorkflowStepKey, StepMove)>,
    /// Each gate answer the turn writes, its outcome beside its approval step, recorded once the
    /// write commits.
    gates: Vec<(ApprovalDecision, Option<WorkflowNodeId>)>,
    /// The run's ending, which the turn's write stores in place of its status move.
    ending: Option<RunEnding>,
    /// Whether the ending posts the run's results into its session after the ending event.
    posts_results: bool,
}

/// How a run ends, which the turn that decides it writes as its last row change and run event.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) enum RunEnding {
    /// Every step settled and none stopped the run: `succeeded`.
    Completed,
    /// A step's failure ended the run: `failed`, with the run's error.
    Failed {
        /// The step the ending sits on.
        step: WorkflowStepKey,
        /// The run's error: the ending step's own, or the run cap's.
        error: WorkflowStepError,
    },
    /// A person canceled the run: `canceled`.
    Canceled {
        /// The person's reason, where one was given.
        reason: Option<WorkflowCancelReason>,
        /// The run's error, carrying the reason as its message, where the cancel gave one.
        error: Option<WorkflowStepError>,
    },
}

/// An event of the turn, at the instant it records.
struct TurnEvent {
    /// When it occurred: its report's instant, or the walk's decision's.
    at: WireInstant,
    /// The event, typed, so a step it readies is added to its readied steps.
    event: SessionEvent,
}

/// What a report did to its step, kept owned until the write commits and the record takes it.
enum StepMove {
    /// The memory gate holds the step.
    WaitingOnPool {
        /// When the hold began.
        hold_started_at: WireInstant,
    },
    /// The memory gate admitted the step.
    Admitted,
    /// The step started.
    Started,
    /// The step is winding down.
    Canceling,
    /// The step's turn canceled a wave of its run's other branches.
    BranchesCanceled {
        /// Why.
        reason: BranchCancelReason,
        /// How many.
        count: usize,
    },
    /// The step ended, with its failure where it failed.
    Settled(StepEnding<StepFailure>),
    /// The step's settlement opened a wait, on a person or on a spent account.
    WaitOpened {
        /// What it waits on.
        cause: WorkflowWaitCause,
        /// When a person wait gives up, where its node set a timeout.
        deadline_at: Option<WireInstant>,
    },
}

/// What the tick knows of a reporting step, which the commit reads and never keeps.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct ReportedStep<'tick> {
    /// The sequence of the event whose write readied the step, which every hold report names.
    pub(crate) readying_sequence: SafeInt<0>,
    /// The instant of the hold's previous report, `Some` only while the memory gate holds the
    /// step; a later report of that hold, or a failure or wait that cuts it, adds its pool wait
    /// from here.
    pub(crate) last_hold_report_at: Option<&'tick WireInstant>,
    /// The step's node.
    pub(crate) node: &'tick WorkflowNode,
    /// The node's kind.
    pub(crate) spec: &'tick WorkflowNodeKindSpec,
    /// The step's input items, one list per input handle of `spec`.
    pub(crate) inputs: &'tick [Vec<WorkflowItem>],
    /// Where the step stands before the report, which the run's step counts move it from.
    pub(crate) status: WorkflowStepStatus,
    /// What the step waits on, while it is `waiting`.
    pub(crate) wait_cause: Option<WorkflowWaitCause>,
}

impl ReportedStep<'_> {
    /// The step's status and wait cause before the report.
    fn standing(&self) -> (WorkflowStepStatus, Option<WorkflowWaitCause>) {
        (self.status, self.wait_cause)
    }
}

/// What a settled step hands back to the tick, moved, never copied: what follows and what the
/// tick keeps of it.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) enum SettlementAnswer {
    /// The step completed; its successors ride `workflow.step.completed`.
    Completed {
        /// The index of `workflow.step.completed`, which `readied` takes.
        readying_event: usize,
        /// The output items, one list per main output.
        outputs: Vec<Vec<WorkflowItem>>,
        /// The run variables it set.
        run_variables: BTreeMap<String, StepRunVariable>,
    },
    /// The step failed and runs again after `wait`; the tick asks the walk for its next attempt
    /// and hands it to `retried`.
    Retry {
        /// The wait before the next attempt runs.
        wait: Duration,
    },
    /// The step failed and its node's `onError` passes its input on; its successors ride
    /// `workflow.step.failed`.
    PassOn {
        /// The index of `workflow.step.failed`, which `readied` takes.
        readying_event: usize,
        /// The outputs, one list per main output, the error output last where the node has one.
        outputs: Vec<Vec<WorkflowItem>>,
    },
    /// The step failed and parks its run; the tick stops its siblings as a park.
    Park,
    /// The step failed and ends its run; the tick stops its siblings as an end.
    End {
        /// The step's error, which the run's ending carries.
        error: WorkflowStepError,
    },
    /// The step waits on a person, its wait stored by this turn's write; the tick asks the person
    /// once the write commits and arms the deadline clock again where `opened.deadline_at` is set.
    PersonWait {
        /// The wait opened.
        opened: OpenedPersonWait,
        /// What the person is asked.
        ask: PersonAsk,
        /// The step's place at the memory gate, parked while it waits; `None` for a step the gate
        /// does not weigh.
        admission: Option<Arc<dyn StepAdmissionTicket>>,
    },
    /// The step waits on its agent run's spent account.
    AccountSpent {
        /// The step's agent run with its params' records, kept to resume when the account is back.
        parked: ParkedAgentRun,
        /// When the step resumes itself, where a resume is armed.
        resume_at: Option<WireInstant>,
    },
    /// The step was canceled; a step its leaving readies rides `workflow.step.canceled`.
    Canceled {
        /// The index of `workflow.step.canceled`, which `readied` takes.
        readying_event: usize,
    },
}

/// Why a settlement was not added to the turn: a payload it stores could not be written. Nothing
/// of the settlement is in the turn; the rest of the turn still commits.
#[derive(Debug)]
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct SettlementWriteFailure {
    /// The payload write that failed.
    pub(crate) error: StepPayloadWriteError,
    /// Each artifact the settlement wrote before the failure, which no record names, for the tick
    /// to delete through the payload store.
    pub(crate) artifact_ids: Vec<ArtifactId>,
}

/// What a committed turn answers: each event's sequence, in write order, the readying sequence of
/// each step whose `pending` row the write stored, the run's step counts and person-wait columns
/// after the turn, which the tick keeps for the run's next turn, the artifacts of the kept values
/// the write replaced, which the tick deletes, and the id of the run's ending event, where the
/// write ended the run.
#[derive(Debug, PartialEq)]
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct RunTurnCommitted {
    /// Each event's sequence, in write order.
    pub(crate) event_sequences: Vec<SafeInt<0>>,
    /// Each step readied, beside the sequence of the event whose write readied it, which the tick
    /// keeps as that step's readying sequence.
    pub(crate) readied: Vec<(WorkflowStepKey, SafeInt<0>)>,
    /// The run's step counts after the turn.
    pub(crate) counts: RunStepCounts,
    /// The run's person-wait columns after the turn.
    pub(crate) person_wait: RunPersonWait,
    /// Each artifact a kept value the write replaced named, which no record names now, for the
    /// tick to delete through the payload store.
    pub(crate) dropped_kept_artifact_ids: Vec<ArtifactId>,
    /// The id of the run's ending event, where the write ended the run.
    pub(crate) ending_event_id: Option<SessionEventId>,
}

/// A session event's id, as the event log gives it.
pub(crate) type SessionEventId = FreeFormText<EVENT_FIELD_MAX_LEN>;

/// Why a turn's write was not kept; none of it is stored.
#[derive(Debug)]
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct RunTurnCommitFailure {
    /// The event that would not draft, or the append that was not kept.
    pub(crate) error: SessionEventEmitError,
    /// Every artifact a payload ref of the write names, which no record now names, for the tick
    /// to delete through the payload store.
    pub(crate) artifact_ids: Vec<ArtifactId>,
}

#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
impl RunTurnCommit {
    /// An empty turn of the run `run_id`, whose events name `keys`, in its execution `epoch`, with
    /// its step counts and person-wait columns as the tick keeps them, storing a payload above the
    /// inline cap through `payloads`.
    pub(crate) fn new(
        keys: RunEventKeys,
        run_id: WorkflowRunId,
        epoch: WorkflowRunEpoch,
        counts: RunStepCounts,
        person_wait: RunPersonWait,
        payloads: Arc<dyn StepPayloadArtifacts>,
    ) -> Self {
        Self {
            keys,
            run_id,
            epoch,
            resumed_event: None,
            counts,
            status_before: going_run_status(&counts),
            person_wait,
            payloads,
            events: Vec::new(),
            statements: Vec::new(),
            pending: Vec::new(),
            artifact_ids: Vec::new(),
            kept_reads: KeptArtifactReads::default(),
            moves: Vec::new(),
            gates: Vec::new(),
            ending: None,
            posts_results: false,
        }
    }

    /// The run this turn writes.
    pub(crate) fn run_id(&self) -> WorkflowRunId {
        self.run_id
    }

    /// The run's person-wait columns as the turn found them; the write moves them last.
    pub(crate) fn person_wait(&self) -> &RunPersonWait {
        &self.person_wait
    }

    /// Ends the run as `ending` says in this turn's write, its row and its run event after every
    /// other, at the instant of the turn's last event, followed by `workflow.results.posted` into
    /// the run's session where `posts_results`.
    pub(crate) fn end(&mut self, ending: RunEnding, posts_results: bool) {
        self.ending = Some(ending);
        self.posts_results = posts_results;
    }

    /// Applies `report` of `reported`, its events at its instant and its row changes after the
    /// turn's earlier ones, writing any payload above the inline cap first. Only a settlement
    /// answers, with what the tick keeps of it. Fails with [`SettlementWriteFailure`] when a
    /// settlement's payload cannot be written, nothing of that settlement added.
    pub(crate) async fn report(
        &mut self,
        report: StepReport,
        reported: ReportedStep<'_>,
    ) -> Result<Option<SettlementAnswer>, SettlementWriteFailure> {
        let StepReport { step, at, kind } = report;
        let session_id = self.keys.session_id;
        let readying_sequence = reported.readying_sequence;
        let last_hold_report_at = reported.last_hold_report_at;
        match kind {
            StepReportKind::WaitingOnPool { hold_started_at } => {
                if at == hold_started_at {
                    self.statements.push(hold_step(&step));
                    self.counts.moved(
                        Some(reported.standing()),
                        (WorkflowStepStatus::WaitingMemory, None),
                    );
                } else {
                    let since = last_hold_report_at.unwrap_or(&hold_started_at);
                    let pool_wait_ms = whole_milliseconds_between(since, &at);
                    self.statements
                        .push(add_step_pool_wait(&step, pool_wait_ms));
                }
                self.push(
                    &at,
                    SessionEvent::WorkflowPhaseWaitingOnPool(step_payload!(
                        WorkflowPhaseWaitingOnPoolPayload,
                        session_id,
                        step,
                        waiting_since_seq: readying_sequence,
                    )),
                );
                self.moves
                    .push((step, StepMove::WaitingOnPool { hold_started_at }));
            }
            StepReportKind::Admitted { hold_started_at } => {
                let pool_wait_ms =
                    held_milliseconds(hold_started_at.as_ref(), last_hold_report_at, &at);
                self.statements.push(admit_step(&step, pool_wait_ms));
                self.counts.moved(
                    Some(reported.standing()),
                    (WorkflowStepStatus::Running, None),
                );
                self.counts.admitted();
                self.push(
                    &at,
                    SessionEvent::WorkflowPhaseAdmitted(step_payload!(
                        WorkflowPhaseAdmittedPayload,
                        session_id,
                        step,
                    )),
                );
                self.moves.push((step, StepMove::Admitted));
            }
            StepReportKind::Started {
                input_ref,
                permission_level,
                pin_hash,
            } => {
                if permission_level.is_some() || pin_hash.is_some() {
                    self.statements.push(record_step_start(
                        &step,
                        permission_level,
                        pin_hash.as_ref(),
                    ));
                }
                self.push(
                    &at,
                    SessionEvent::WorkflowPhaseStarted(step_payload!(
                        WorkflowPhaseStartedPayload,
                        session_id,
                        step,
                    )),
                );
                self.push(
                    &at,
                    SessionEvent::WorkflowStepStarted(step_payload!(
                        WorkflowStepStartedPayload,
                        session_id,
                        step,
                        input_ref: input_ref,
                        permission_level: permission_level,
                        pin_hash: pin_hash,
                    )),
                );
                self.moves.push((step, StepMove::Started));
            }
            StepReportKind::Progressed => self.push(
                &at,
                SessionEvent::WorkflowPhaseProgressed(step_payload!(
                    WorkflowPhaseProgressedPayload,
                    session_id,
                    step,
                )),
            ),
            StepReportKind::Canceling => {
                self.push(
                    &at,
                    SessionEvent::WorkflowPhaseCanceling(step_payload!(
                        WorkflowPhaseCancelingPayload,
                        session_id,
                        step,
                    )),
                );
                self.moves.push((step, StepMove::Canceling));
            }
            StepReportKind::BranchesCanceled { reason, count } => {
                self.branches_canceled(step, &at, reason, count);
            }
            StepReportKind::ResumeDue { .. } => {
                self.resume_step(&step, None, WorkflowWaitCause::Account, &at);
            }
            // The tick ends a capped run on the step it picks, as that step's failure.
            StepReportKind::RunCapped { .. } => {}
            StepReportKind::Settled(settlement) => {
                return self
                    .settle(step, &at, settlement, &reported)
                    .await
                    .map(Some);
            }
        }
        Ok(None)
    }

    /// Cancels `step`, readied in this turn and never run, at `at`: its row and
    /// `workflow.step.canceled` with nothing readied, its count moved from `pending`.
    pub(crate) fn canceled_unrun(&mut self, step: &WorkflowStepKey, at: &WireInstant) {
        self.cancel(
            step.clone(),
            at,
            0,
            None,
            (WorkflowStepStatus::Pending, None),
        );
    }

    /// Writes `workflow.parallelJoin.branchesCanceled` on `step` at `at`, whose turn canceled
    /// `count` of its run's running branches for `reason`, and records the decision. The step
    /// need not be live: the deciding step may have settled before its wave did.
    pub(crate) fn branches_canceled(
        &mut self,
        step: WorkflowStepKey,
        at: &WireInstant,
        reason: BranchCancelReason,
        count: usize,
    ) {
        let session_id = self.keys.session_id;
        self.push(
            at,
            SessionEvent::WorkflowParallelJoinBranchesCanceled(step_payload!(
                WorkflowParallelJoinBranchesCanceledPayload,
                session_id,
                step,
            )),
        );
        self.moves
            .push((step, StepMove::BranchesCanceled { reason, count }));
    }

    /// Writes the `skipped` row of `skip` at `at`, on `input_ref`, passing `output_ref` on, and
    /// its `workflow.step.skipped`, each naming the step a reused skip reused and that step's pin
    /// hash; answers that event's index, for the steps its write readies.
    pub(crate) fn skipped(
        &mut self,
        skip: &WalkSkip,
        input_ref: &WorkflowPayloadRef,
        output_ref: &WorkflowPayloadRef,
        at: WireInstant,
    ) -> usize {
        let (skip_reason, reused) = match &skip.reason {
            WalkSkipReason::NoItems => (WorkflowStepSkipReason::NoItems, None),
            WalkSkipReason::Disabled => (WorkflowStepSkipReason::Disabled, None),
            WalkSkipReason::Reused(reused) => (WorkflowStepSkipReason::Reused, Some(reused)),
        };
        let pin_hash = reused.and_then(|reused| reused.pin_hash.as_ref());
        self.statements.push(insert_skipped_step(
            &skip.step,
            &skip.sources,
            input_ref,
            output_ref,
            &skip.output_lengths,
            &at,
            (reused.map(|reused| &reused.from), pin_hash),
        ));
        self.keep_artifact(input_ref);
        // A reused step's own output belongs to the run that recorded it, so a refused turn
        // never deletes it; a copy stored for this run is the turn's.
        if reused.is_none_or(|reused| reused.output_ref != *output_ref) {
            self.keep_artifact(output_ref);
        }
        let session_id = self.keys.session_id;
        let step = &skip.step;
        self.events.push(TurnEvent {
            at,
            event: SessionEvent::WorkflowStepSkipped(step_payload!(
                WorkflowStepSkippedPayload,
                session_id,
                step,
                reason: skip_reason,
                sources: skip.sources.clone(),
                input_ref: input_ref.clone(),
                output_ref: output_ref.clone(),
                output_item_counts: skip
                    .output_lengths
                    .iter()
                    .copied()
                    .map(SafeInt::from_usize)
                    .collect(),
                readied: Vec::new(),
                reused_from: reused.map(|reused| reused.from.clone()),
                pin_hash: pin_hash.cloned(),
            )),
        });
        self.events.len() - 1
    }

    /// Writes the `pending` row of `ready` on `input_ref`, at the instant of the event at
    /// `readying_event`, and adds the step to that event's readied steps.
    pub(crate) fn readied(
        &mut self,
        ready: &WalkReady,
        input_ref: WorkflowPayloadRef,
        readying_event: usize,
    ) {
        self.keep_artifact(&input_ref);
        self.add_pending(ready, input_ref, readying_event);
    }

    /// Writes the `pending` row of `ready`, the next attempt of a step a failed park stopped, on
    /// `input_ref`, the earlier attempt's own input, in the readied steps of the event at
    /// `readying_event`; that input's committed row already names it, so a failed turn keeps it.
    pub(crate) fn rerun(
        &mut self,
        ready: &WalkReady,
        input_ref: WorkflowPayloadRef,
        readying_event: usize,
    ) {
        self.add_pending(ready, input_ref, readying_event);
    }

    /// Writes `workflow.phase.retried` naming `ready`, the failed step's next attempt the walk's
    /// retry answered, at the failure's instant, and the attempt's `pending` row on `input_ref`,
    /// the failed attempt's own input, in that event's readied steps. Called right after the
    /// failure's [`SettlementAnswer::Retry`], so the turn's last event is the failure's.
    pub(crate) fn retried(&mut self, ready: &WalkReady, input_ref: WorkflowPayloadRef) {
        let at = self
            .events
            .last()
            .expect("a retry follows its failure's events in the turn")
            .at
            .clone();
        let session_id = self.keys.session_id;
        self.push(
            &at,
            SessionEvent::WorkflowPhaseRetried(step_payload!(
                WorkflowPhaseRetriedPayload,
                session_id,
                ready.step,
                readied: Vec::new(),
            )),
        );
        // The failed attempt's committed row already names its input, so a failed turn keeps it.
        let readying_event = self.events.len() - 1;
        self.add_pending(ready, input_ref, readying_event);
    }

    /// Writes the `pending` row of `ready` on `input_ref` at the instant of the event at
    /// `readying_event`, and adds the step to that event's readied steps.
    fn add_pending(
        &mut self,
        ready: &WalkReady,
        input_ref: WorkflowPayloadRef,
        readying_event: usize,
    ) {
        self.counts.moved(None, (WorkflowStepStatus::Pending, None));
        self.statements.push(insert_pending_step(
            &ready.step,
            &ready.sources,
            &input_ref,
            &self.events[readying_event].at,
        ));
        let event = &mut self.events[readying_event].event;
        let readied = if let SessionEvent::WorkflowStepSkipped(readying) = event {
            &mut readying.readied
        } else if let SessionEvent::WorkflowStepCompleted(readying) = event {
            &mut readying.readied
        } else if let SessionEvent::WorkflowStepFailed(readying) = event {
            &mut readying.readied
        } else if let SessionEvent::WorkflowPhaseRetried(readying) = event {
            &mut readying.readied
        } else if let SessionEvent::WorkflowStepCanceled(readying) = event {
            &mut readying.readied
        } else if let SessionEvent::WorkflowRunResumed(readying) = event {
            &mut readying.readied
        } else {
            unreachable!("a step is readied only by an event that carries its readied steps")
        };
        readied.push(WorkflowReadiedStep {
            node_id: ready.step.node_id.clone(),
            attempt: ready.step.attempt,
            execution_index: ready.step.execution_index,
            sources: ready.sources.clone(),
            input_ref,
        });
        self.pending.push((ready.step.clone(), readying_event));
    }

    /// Adds `event` at `at` after the turn's earlier events.
    fn push(&mut self, at: &WireInstant, event: SessionEvent) {
        self.events.push(TurnEvent {
            at: at.clone(),
            event,
        });
    }

    /// Keeps the artifact `payload` names, if any, among the turn's.
    fn keep_artifact(&mut self, payload: &WorkflowPayloadRef) {
        if let WorkflowPayloadRef::Artifact { artifact_id, .. } = payload
            && !self.artifact_ids.contains(artifact_id)
        {
            self.artifact_ids.push(*artifact_id);
        }
    }
}

impl StepMove {
    /// The move as the engine's record carries it.
    fn decision(&self) -> EngineDecision<'_> {
        let transition = match self {
            Self::WaitingOnPool { hold_started_at } => {
                StepTransition::WaitingOnPool { hold_started_at }
            }
            Self::Admitted => StepTransition::Admitted,
            Self::Started => StepTransition::Started,
            Self::Canceling => StepTransition::Canceling,
            Self::BranchesCanceled { reason, count } => StepTransition::BranchesCanceled {
                reason: *reason,
                count: *count,
            },
            Self::Settled(ending) => StepTransition::Settled(match ending {
                StepEnding::Completed => StepEnding::Completed,
                StepEnding::Failed(failure) => StepEnding::Failed(failure),
                StepEnding::PersonWait => StepEnding::PersonWait,
                StepEnding::AccountSpent => StepEnding::AccountSpent,
                StepEnding::Canceled => StepEnding::Canceled,
            }),
            Self::WaitOpened { cause, deadline_at } => {
                return EngineDecision::WaitOpened {
                    cause: *cause,
                    deadline_at: deadline_at.clone(),
                };
            }
        };
        EngineDecision::StepReported(transition)
    }
}

/// The whole milliseconds a hold that began at `hold_started_at` ran from its last report, at
/// `last_hold_report_at` or its start, to `at`; 0 for a step the gate was not holding.
fn held_milliseconds(
    hold_started_at: Option<&WireInstant>,
    last_hold_report_at: Option<&WireInstant>,
    at: &WireInstant,
) -> u64 {
    hold_started_at.map_or(0, |hold_started_at| {
        whole_milliseconds_between(last_hold_report_at.unwrap_or(hold_started_at), at)
    })
}

#[cfg(test)]
mod tests;
