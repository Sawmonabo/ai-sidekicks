//! One run's turn as the event log keeps it: what the run's steps reported and what the walk
//! decided, turned into the run's events and row changes and committed in one append, each event
//! at the instant its report was made, so the live rows and the fold read one instant.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use sidekicks_contracts::approval::ApprovalDecision;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::document::{WorkflowNode, WorkflowNodeId};
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::kind::WorkflowNodeKindSpec;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::{
    WorkflowRunStatus, WorkflowStepStatus, WorkflowWaitCause,
};
use sidekicks_contracts::workflow::run::step::events::{
    WorkflowParallelJoinBranchesCanceledPayload, WorkflowPhaseAdmittedPayload,
    WorkflowPhaseCancelingPayload, WorkflowPhaseProgressedPayload, WorkflowPhaseRetriedPayload,
    WorkflowPhaseStartedPayload, WorkflowPhaseWaitingOnPoolPayload, WorkflowReadiedStep,
    WorkflowStepSkippedPayload, WorkflowStepStartedPayload,
};
use sidekicks_contracts::workflow::run::step::record::{WorkflowPayloadRef, WorkflowStepKey};
use sidekicks_store::database::statement::WriteStatement;
use sidekicks_store::events::session::appender::{
    SessionEventAppender, SessionEventDraft, SessionEventEmitError, SessionEventLinkage,
};

use super::run_status::{
    GoingRunStatus, RunPersonWait, RunStepCounts, going_run_status, whole_milliseconds_between,
};
use super::walk::{WalkReady, WalkSkip};
use super::{BranchCancelReason, StepReport, StepReportKind};
use crate::engine::event_record::{EngineDecision, RunEngineRecord, StepEnding, StepTransition};
use crate::engine::ports::{AgentStepRun, StepAdmissionTicket, StepPayloadArtifacts};
use crate::engine::waits::OpenedPersonWait;
use crate::kinds::step_context::StepRunVariable;
use crate::kinds::{PersonAsk, StepFailure};
use crate::runs::gate_resolution::RunEventKeys;
use crate::runs::step_payload::StepPayloadWriteError;
use crate::runs::step_rows::{
    add_step_pool_wait, admit_step, hold_step, insert_pending_step, insert_skipped_step,
    set_step_permission_level,
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

pub(crate) use run_events::RunLiveStep;

/// One run's events and row statements for this turn, in the order handed: each event typed,
/// with its instant, until the append drafts it, since a readied step adds to an event held.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct RunTurnCommit {
    /// The run's session, whose log takes the write, its definition and the version it pins.
    keys: RunEventKeys,
    /// The run.
    run_id: WorkflowRunId,
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
    /// Each applied report that moved its step, recorded once the write commits.
    moves: Vec<(WorkflowStepKey, StepMove)>,
    /// Each gate answer the turn writes, its outcome beside its approval step, recorded once the
    /// write commits.
    gates: Vec<(ApprovalDecision, Option<WorkflowNodeId>)>,
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
    End,
    /// The step waits on a person, its wait stored by this turn's write; the tick asks the person
    /// once the write commits and arms the deadline clock again where `opened.deadline_at` is set.
    PersonWait {
        /// The wait opened.
        opened: OpenedPersonWait,
        /// What the person is asked.
        #[cfg_attr(
            test,
            expect(dead_code, reason = "the tick's loop, which asks the person")
        )]
        ask: PersonAsk,
        /// The step's place at the memory gate, parked while it waits; `None` for a step the gate
        /// does not weigh.
        #[cfg_attr(
            test,
            expect(dead_code, reason = "the tick's loop, which parks the place")
        )]
        admission: Option<Arc<dyn StepAdmissionTicket>>,
    },
    /// The step waits on its agent run's spent account.
    AccountSpent {
        /// The step's agent run, kept to resume when the account is back.
        run: Box<dyn AgentStepRun>,
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
/// each step whose `pending` row the write stored, and the run's step counts and person-wait
/// columns after the turn, which the tick keeps for the run's next turn.
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
}

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
    /// An empty turn of the run `run_id`, whose events name `keys`, with its step counts and
    /// person-wait columns as the tick keeps them, storing a payload above the inline cap through
    /// `payloads`.
    pub(crate) fn new(
        keys: RunEventKeys,
        run_id: WorkflowRunId,
        counts: RunStepCounts,
        person_wait: RunPersonWait,
        payloads: Arc<dyn StepPayloadArtifacts>,
    ) -> Self {
        Self {
            keys,
            run_id,
            counts,
            status_before: going_run_status(&counts),
            person_wait,
            payloads,
            events: Vec::new(),
            statements: Vec::new(),
            pending: Vec::new(),
            artifact_ids: Vec::new(),
            moves: Vec::new(),
            gates: Vec::new(),
        }
    }

    /// The run this turn writes.
    pub(crate) fn run_id(&self) -> WorkflowRunId {
        self.run_id
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
                return self
                    .settle(step, &at, settlement, &reported)
                    .await
                    .map(Some);
            }
        }
        Ok(None)
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
            &skip.output_lengths,
            &at,
        ));
        self.keep_artifact(input_ref);
        self.keep_artifact(output_ref);
        let session_id = self.keys.session_id;
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
        self.keep_artifact(&input_ref);
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

    /// Commits the turn through `appender` in one write: its events, then the run event its
    /// status move implies as the last, and every statement ahead of the rows, the run's own after
    /// the steps'. `live_steps` are the run's steps the tick keeps live after the turn, which a
    /// resumption point names beside the steps this turn readied. Once it commits, each report
    /// that moved its step, each gate answer and the run's status go to `record`. A turn with
    /// nothing writes nothing. Fails with [`RunTurnCommitFailure`], nothing of the turn stored.
    pub(crate) async fn append<'tick>(
        self,
        appender: &SessionEventAppender,
        record: &RunEngineRecord,
        live_steps: impl IntoIterator<Item = RunLiveStep<'tick>>,
    ) -> Result<RunTurnCommitted, RunTurnCommitFailure> {
        let DraftedTurn {
            session_id: _,
            mut drafts,
            statements,
            artifact_ids,
            answer,
        } = self.drafted(live_steps)?;
        let event_count = drafts.len();
        let Some(last) = drafts.pop() else {
            return Ok(answer.unwritten());
        };
        let linkage = SessionEventLinkage {
            transactional_prelude: statements,
            preceding_events: drafts,
            ..SessionEventLinkage::default()
        };
        match appender.append(last, linkage).await {
            Ok(receipt) => Ok(answer
                .recorded(sequences_ending_at(receipt.sequence, event_count), record)
                .await),
            Err(error) => Err(RunTurnCommitFailure {
                error: error.into(),
                artifact_ids,
            }),
        }
    }

    /// Commits the turns of `writes`, each beside its run's live steps and record, in one write
    /// across every session they live in, all or none: the turns of one session in one append, in
    /// the order given, and the sessions in the order their first turn comes. Each turn is drafted
    /// and answers as [`RunTurnCommit::append`] says. Every session's turns hold an event. Fails
    /// with [`RunTurnCommitFailure`], nothing of any turn stored, naming every turn's artifacts;
    /// a refused statement's index counts across the whole write.
    pub(crate) async fn append_together<'tick>(
        writes: Vec<(
            RunTurnCommit,
            Vec<RunLiveStep<'tick>>,
            &'tick RunEngineRecord,
        )>,
        appender: &SessionEventAppender,
    ) -> Result<Vec<RunTurnCommitted>, RunTurnCommitFailure> {
        let mut drafted = Vec::with_capacity(writes.len());
        let mut draft_error = None;
        let mut artifact_ids = Vec::new();
        for (commit, live_steps, record) in writes {
            match commit.drafted(live_steps) {
                Ok(turn) => {
                    artifact_ids.extend(turn.artifact_ids.iter().copied());
                    drafted.push((turn, record));
                }
                Err(failure) => {
                    artifact_ids.extend(failure.artifact_ids);
                    draft_error.get_or_insert(failure.error);
                }
            }
        }
        if let Some(error) = draft_error {
            return Err(RunTurnCommitFailure {
                error,
                artifact_ids,
            });
        }
        // Each session's turns, by their place in `drafted`, in the order the sessions first come.
        let mut sessions: Vec<(SessionId, Vec<usize>)> = Vec::new();
        for (place, (turn, _)) in drafted.iter().enumerate() {
            match sessions
                .iter_mut()
                .find(|(session_id, _)| *session_id == turn.session_id)
            {
                Some((_, places)) => places.push(place),
                None => sessions.push((turn.session_id, vec![place])),
            }
        }
        let event_counts: Vec<usize> = drafted.iter().map(|(turn, _)| turn.drafts.len()).collect();
        let mut appends = Vec::with_capacity(sessions.len());
        for (_, places) in &sessions {
            let mut drafts = Vec::new();
            let mut statements = Vec::new();
            for &place in places {
                let turn = &mut drafted[place].0;
                drafts.append(&mut turn.drafts);
                statements.append(&mut turn.statements);
            }
            let last = drafts
                .pop()
                .expect("every session's turns of a write hold an event");
            appends.push((
                last,
                SessionEventLinkage {
                    transactional_prelude: statements,
                    preceding_events: drafts,
                    ..SessionEventLinkage::default()
                },
            ));
        }
        let receipts = match appender.append_together(appends).await {
            Ok(receipts) => receipts,
            Err(error) => {
                return Err(RunTurnCommitFailure {
                    error: error.into(),
                    artifact_ids,
                });
            }
        };
        let mut sequences: Vec<Vec<SafeInt<0>>> = vec![Vec::new(); drafted.len()];
        for ((_, places), receipt) in sessions.iter().zip(receipts) {
            let session_count: usize = places.iter().map(|&place| event_counts[place]).sum();
            let mut session_sequences =
                sequences_ending_at(receipt.sequence, session_count).into_iter();
            for &place in places {
                sequences[place] = session_sequences
                    .by_ref()
                    .take(event_counts[place])
                    .collect();
            }
        }
        let mut committed = Vec::with_capacity(drafted.len());
        for ((turn, record), turn_sequences) in drafted.into_iter().zip(sequences) {
            committed.push(turn.answer.recorded(turn_sequences, record).await);
        }
        Ok(committed)
    }

    /// The turn drafted for its write: the run's status move added, then each event drafted at its
    /// instant. Fails with [`RunTurnCommitFailure`] when an event does not draft.
    fn drafted<'tick>(
        mut self,
        live_steps: impl IntoIterator<Item = RunLiveStep<'tick>>,
    ) -> Result<DraftedTurn, RunTurnCommitFailure> {
        let run_status = self.add_run_status_move(live_steps);
        let Self {
            keys,
            run_id: _,
            counts,
            status_before: _,
            person_wait,
            payloads: _,
            events,
            statements,
            pending,
            artifact_ids,
            moves,
            gates,
        } = self;
        let drafted = events
            .into_iter()
            .map(|turn_event| {
                Ok(
                    SessionEventDraft::of_session(keys.session_id, &turn_event.event)?
                        .with_occurred_at(turn_event.at),
                )
            })
            .collect::<Result<Vec<_>, SessionEventEmitError>>();
        match drafted {
            Ok(drafts) => Ok(DraftedTurn {
                session_id: keys.session_id,
                drafts,
                statements,
                artifact_ids,
                answer: TurnAnswer {
                    pending,
                    moves,
                    gates,
                    run_status,
                    counts,
                    person_wait,
                },
            }),
            Err(error) => Err(RunTurnCommitFailure {
                error,
                artifact_ids,
            }),
        }
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

/// A turn drafted for its write: its session, its events and statements, the artifacts its
/// payload refs name, and what it answers once the write commits.
struct DraftedTurn {
    session_id: SessionId,
    drafts: Vec<SessionEventDraft>,
    statements: Vec<WriteStatement>,
    artifact_ids: Vec<ArtifactId>,
    answer: TurnAnswer,
}

/// What a drafted turn records and answers once its write commits.
struct TurnAnswer {
    /// Each step whose `pending` row the turn writes, beside the index of the event it rides.
    pending: Vec<(WorkflowStepKey, usize)>,
    moves: Vec<(WorkflowStepKey, StepMove)>,
    gates: Vec<(ApprovalDecision, Option<WorkflowNodeId>)>,
    /// The status the turn stored on the run, where it moved it.
    run_status: Option<WorkflowRunStatus>,
    counts: RunStepCounts,
    person_wait: RunPersonWait,
}

impl TurnAnswer {
    /// The answer of a turn that wrote nothing: the counts and the columns as handed in.
    fn unwritten(self) -> RunTurnCommitted {
        RunTurnCommitted {
            event_sequences: Vec::new(),
            readied: Vec::new(),
            counts: self.counts,
            person_wait: self.person_wait,
        }
    }

    /// The answer of a turn whose events committed at `event_sequences`, in write order, once
    /// each move, gate answer and status move went to `record`.
    async fn recorded(
        self,
        event_sequences: Vec<SafeInt<0>>,
        record: &RunEngineRecord,
    ) -> RunTurnCommitted {
        let readied = self
            .pending
            .into_iter()
            .map(|(step, readying_event)| (step, event_sequences[readying_event]))
            .collect();
        for (step, step_move) in &self.moves {
            record.decision(Some(step), step_move.decision()).await;
        }
        for (outcome, node_id) in self.gates {
            record
                .decision(None, EngineDecision::GateResolved { outcome, node_id })
                .await;
        }
        if let Some(status) = self.run_status {
            record
                .decision(None, EngineDecision::RunStatus(status))
                .await;
        }
        RunTurnCommitted {
            event_sequences,
            readied,
            counts: self.counts,
            person_wait: self.person_wait,
        }
    }
}

/// The sequences of `count` events of one session's write, consecutive and ending at `last`.
fn sequences_ending_at(last: SafeInt<0>, count: usize) -> Vec<SafeInt<0>> {
    let count = SafeInt::from_usize(count).get();
    let first = last.get() + 1 - count;
    (0..count)
        .map(|offset| {
            SafeInt::new(first + offset).expect("a sequence below the last one's is safe")
        })
        .collect()
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
