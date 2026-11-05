//! One run's turn as the event log keeps it: what the run's steps reported and what the walk
//! decided, turned into the run's events and row changes and committed in one append, each event
//! at the instant its report was made, so the live rows and the fold read one instant.

use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::run::step::events::{
    WorkflowParallelJoinBranchesCanceledPayload, WorkflowPhaseAdmittedPayload,
    WorkflowPhaseCancelingPayload, WorkflowPhaseCancellationReason, WorkflowPhaseFailedPayload,
    WorkflowPhaseProgressedPayload, WorkflowPhaseStartedPayload, WorkflowPhaseWaitingOnPoolPayload,
    WorkflowReadiedStep, WorkflowStepCanceledPayload, WorkflowStepSkippedPayload,
    WorkflowStepStartedPayload,
};
use sidekicks_contracts::workflow::run::step::record::{WorkflowPayloadRef, WorkflowStepKey};
use sidekicks_store::database::statement::WriteStatement;
use sidekicks_store::events::session::appender::{
    SessionEventAppender, SessionEventDraft, SessionEventEmitError, SessionEventLinkage,
};

use super::run_status::whole_milliseconds_between;
use super::walk::{WalkReady, WalkSkip};
use super::{BranchCancelReason, StepReport, StepReportKind, StepSettlement};
use crate::engine::event_record::{EngineDecision, RunEngineRecord, StepTransition};
use crate::runs::step_rows::{
    add_step_pool_wait, admit_step, cancel_step, hold_step, insert_pending_step,
    insert_skipped_step, set_step_permission_level,
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

/// One run's events and row statements for this turn, in the order handed: each event typed,
/// with its instant, until the append drafts it, since a readied step adds to an event held.
#[cfg_attr(not(test), expect(dead_code, reason = "the tick's loop"))]
pub(crate) struct RunTurnCommit {
    /// The session the run lives in, whose log takes the write.
    session_id: SessionId,
    /// The turn's events, in write order.
    events: Vec<TurnEvent>,
    /// The turn's row statements, in the order handed.
    statements: Vec<WriteStatement>,
    /// Each step whose `pending` row this turn writes, beside the index of the event it rides.
    pending: Vec<(WorkflowStepKey, usize)>,
    /// Each artifact a payload ref this turn stores names, which a failed write leaves unnamed.
    artifact_ids: Vec<ArtifactId>,
    /// Each applied report that moved its step, recorded once the write commits.
    moves: Vec<(WorkflowStepKey, StepMove)>,
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
    /// The step ended.
    Settled(StepSettlement),
}

/// What a committed turn answers: each event's sequence, in write order, and the readying
/// sequence of each step whose `pending` row the write stored.
#[derive(Debug, Default, PartialEq)]
#[cfg_attr(not(test), expect(dead_code, reason = "the tick's loop"))]
pub(crate) struct RunTurnCommitted {
    /// Each event's sequence, in write order.
    pub(crate) event_sequences: Vec<SafeInt<0>>,
    /// Each step readied, beside the sequence of the event whose write readied it, which the tick
    /// keeps as that step's readying sequence.
    pub(crate) readied: Vec<(WorkflowStepKey, SafeInt<0>)>,
}

/// Why a turn's write was not kept; none of it is stored.
#[derive(Debug)]
#[cfg_attr(not(test), expect(dead_code, reason = "the tick's loop"))]
pub(crate) struct RunTurnCommitFailure {
    /// The event that would not draft, or the append that was not kept.
    pub(crate) error: SessionEventEmitError,
    /// Every artifact a payload ref of the write names, which no record now names, for the tick
    /// to delete through the payload store.
    pub(crate) artifact_ids: Vec<ArtifactId>,
}

#[cfg_attr(not(test), expect(dead_code, reason = "the tick's loop"))]
impl RunTurnCommit {
    /// An empty turn of a run living in `session_id`.
    pub(crate) fn new(session_id: SessionId) -> Self {
        Self {
            session_id,
            events: Vec::new(),
            statements: Vec::new(),
            pending: Vec::new(),
            artifact_ids: Vec::new(),
            moves: Vec::new(),
        }
    }

    /// Applies `report`, its events at its instant and its row changes after the turn's earlier
    /// ones. `readying_sequence` is the sequence of the event whose write readied the step, which
    /// every hold report names; `last_hold_report_at` is the instant of the step's hold's previous
    /// report, from which a later report of that hold adds its pool wait.
    pub(crate) fn report(
        &mut self,
        report: StepReport,
        readying_sequence: SafeInt<0>,
        last_hold_report_at: Option<&WireInstant>,
    ) {
        let StepReport { step, at, kind } = report;
        let session_id = self.session_id;
        match kind {
            StepReportKind::WaitingOnPool { hold_started_at } => {
                if at == hold_started_at {
                    self.statements.push(hold_step(&step));
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
            } => {
                if let Some(permission_level) = permission_level {
                    self.statements
                        .push(set_step_permission_level(&step, permission_level));
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
                self.push(
                    &at,
                    SessionEvent::WorkflowParallelJoinBranchesCanceled(step_payload!(
                        WorkflowParallelJoinBranchesCanceledPayload,
                        session_id,
                        step,
                    )),
                );
                self.moves
                    .push((step, StepMove::BranchesCanceled { reason, count }));
            }
            StepReportKind::Settled(settlement) => {
                self.settle(step, &at, settlement, last_hold_report_at);
            }
        }
    }

    /// Writes the `skipped` row of `skip` at `at`, on `input_ref`, passing `output_ref` on, and
    /// its `workflow.step.skipped`; answers that event's index, for the steps its write readies.
    pub(crate) fn skipped(
        &mut self,
        skip: &WalkSkip,
        input_ref: &WorkflowPayloadRef,
        output_ref: &WorkflowPayloadRef,
        at: WireInstant,
    ) -> usize {
        self.statements.push(insert_skipped_step(
            &skip.step,
            &skip.sources,
            input_ref,
            output_ref,
            &at,
        ));
        self.keep_artifact(input_ref);
        self.keep_artifact(output_ref);
        let session_id = self.session_id;
        let step = &skip.step;
        self.events.push(TurnEvent {
            at,
            event: SessionEvent::WorkflowStepSkipped(step_payload!(
                WorkflowStepSkippedPayload,
                session_id,
                step,
                reason: skip.reason,
                readied: Vec::new(),
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
        self.statements.push(insert_pending_step(
            &ready.step,
            &ready.sources,
            &input_ref,
            &self.events[readying_event].at,
        ));
        self.keep_artifact(&input_ref);
        let SessionEvent::WorkflowStepSkipped(readying) = &mut self.events[readying_event].event
        else {
            unreachable!("a step is readied only by an event that carries its readied steps")
        };
        readying.readied.push(WorkflowReadiedStep {
            node_id: ready.step.node_id.clone(),
            attempt: ready.step.attempt,
            execution_index: ready.step.execution_index,
            sources: ready.sources.clone(),
            input_ref,
        });
        self.pending.push((ready.step.clone(), readying_event));
    }

    /// Commits the turn through `appender` in one write: its last event appended with the others
    /// before it and every statement ahead of the rows. Once it commits, each report that moved
    /// its step goes to `record`. A turn with nothing writes nothing. Fails with
    /// [`RunTurnCommitFailure`], nothing of the turn stored.
    pub(crate) async fn append(
        self,
        appender: &SessionEventAppender,
        record: &RunEngineRecord,
    ) -> Result<RunTurnCommitted, RunTurnCommitFailure> {
        let Self {
            session_id,
            events,
            statements,
            pending,
            artifact_ids,
            moves,
        } = self;
        let event_count = events.len();
        let drafted = events
            .into_iter()
            .map(|turn_event| {
                Ok(
                    SessionEventDraft::of_session(session_id, &turn_event.event)?
                        .with_occurred_at(turn_event.at),
                )
            })
            .collect::<Result<Vec<_>, SessionEventEmitError>>();
        let mut drafts = match drafted {
            Ok(drafts) => drafts,
            Err(error) => {
                return Err(RunTurnCommitFailure {
                    error,
                    artifact_ids,
                });
            }
        };
        let Some(last) = drafts.pop() else {
            return Ok(RunTurnCommitted::default());
        };
        let linkage = SessionEventLinkage {
            transactional_prelude: statements,
            preceding_events: drafts,
            ..SessionEventLinkage::default()
        };
        let receipt = match appender.append(last, linkage).await {
            Ok(receipt) => receipt,
            Err(error) => {
                return Err(RunTurnCommitFailure {
                    error: error.into(),
                    artifact_ids,
                });
            }
        };
        // One write's events take consecutive sequences, the last event the receipt's.
        let event_count = SafeInt::from_usize(event_count).get();
        let first = receipt.sequence.get() + 1 - event_count;
        let event_sequences: Vec<SafeInt<0>> = (0..event_count)
            .map(|offset| {
                SafeInt::new(first + offset).expect("a sequence below the receipt's is safe")
            })
            .collect();
        let readied = pending
            .into_iter()
            .map(|(step, readying_event)| (step, event_sequences[readying_event]))
            .collect();
        for (step, step_move) in &moves {
            record
                .decision(
                    Some(step),
                    EngineDecision::StepReported(step_move.transition()),
                )
                .await;
        }
        Ok(RunTurnCommitted {
            event_sequences,
            readied,
        })
    }

    /// Ends `step` at `at` as `settlement` says.
    fn settle(
        &mut self,
        step: WorkflowStepKey,
        at: &WireInstant,
        settlement: StepSettlement,
        last_hold_report_at: Option<&WireInstant>,
    ) {
        let session_id = self.session_id;
        match settlement {
            StepSettlement::Canceled {
                hold_started_at,
                is_sibling_failure,
            } => {
                let pool_wait_ms =
                    held_milliseconds(hold_started_at.as_ref(), last_hold_report_at, at);
                self.statements.push(cancel_step(&step, at, pool_wait_ms));
                if is_sibling_failure {
                    self.push(
                        at,
                        SessionEvent::WorkflowPhaseFailed(step_payload!(
                            WorkflowPhaseFailedPayload,
                            session_id,
                            step,
                            cancellation_reason: Some(
                                WorkflowPhaseCancellationReason::SiblingFailure
                            ),
                        )),
                    );
                }
                self.push(
                    at,
                    SessionEvent::WorkflowStepCanceled(step_payload!(
                        WorkflowStepCanceledPayload,
                        session_id,
                        step,
                    )),
                );
                self.moves.push((
                    step,
                    StepMove::Settled(StepSettlement::Canceled {
                        hold_started_at,
                        is_sibling_failure,
                    }),
                ));
            }
            StepSettlement::Completed { .. }
            | StepSettlement::Failed { .. }
            | StepSettlement::PersonWait { .. }
            | StepSettlement::AccountSpent { .. } => {
                unreachable!(
                    "the tick hands the commit no completed, failed, waiting or parked settlement"
                )
            }
        }
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
    fn transition(&self) -> StepTransition<'_> {
        match self {
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
            Self::Settled(settlement) => StepTransition::Settled(settlement),
        }
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
