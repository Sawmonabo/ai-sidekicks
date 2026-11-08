//! The engine call a delivery on a binding makes once the inbound dispatch has attributed it: a
//! run's move, a continue, a child run's start, a marker or a steer, each absorbed when its run has
//! ended, or a child run's parent correction, which lands on an ended run too. A steer's row moves
//! its binding to the next run position once it is written.

use std::error::Error;

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_provider::run::delivery::{
    ChildRunSubagent, InboundOutcome, LateEventAbsorbReason, RunMarker,
};
use sidekicks_provider::run::state_entry::RunStateReport;
use sidekicks_provider::run::turn_end::ProviderTurnEnd;

use crate::run::engine::SubagentRunStart;
use crate::run::engine::turns::steers::SteerRecord;
use crate::run::epochs::{DeliveryAttribution, EpochBinding};
use crate::run::inbound::{
    AbsorbedDelivery, InboundDispatchError, RunInboundDispatch, is_ended_run_refusal,
    is_resumed_run_refusal,
};
use crate::run::state_change::RunStateChange;

// The engine call a delivery on a binding makes once it is attributed.
pub(super) enum RunWork {
    Lifecycle {
        change: RunStateReport,
        turn_end: Option<ProviderTurnEnd>,
        is_daemon_interrupt_end: bool,
    },
    Continued {
        run_id: RunId,
    },
    ChildRun {
        parent_run_id: RunId,
        subagent: ChildRunSubagent,
    },
    ParentCorrected {
        child_run_id: RunId,
        parent_run_id: RunId,
    },
    Marker {
        marker: RunMarker,
    },
    Steered {
        run_id: RunId,
        turn_number: SafeInt<1>,
        message_id: QueueItemId,
    },
}

impl RunWork {
    pub(super) fn absorbed(&self) -> AbsorbedDelivery {
        let (kind, run_id, new_state) = match self {
            Self::Lifecycle { change, .. } => {
                ("runLifecycle", change.run_id, Some(change.entry.state()))
            }
            Self::Continued { run_id } => ("runContinued", *run_id, None),
            Self::ChildRun { parent_run_id, .. } => ("childRun", *parent_run_id, None),
            Self::ParentCorrected { child_run_id, .. } => {
                ("childRunParentCorrected", *child_run_id, None)
            }
            Self::Marker { marker } => ("runMarker", marker.run_id(), None),
            Self::Steered { run_id, .. } => ("turnSteered", *run_id, None),
        };
        AbsorbedDelivery {
            kind,
            run_id: Some(run_id),
            new_state,
        }
    }
}

impl RunInboundDispatch {
    // Makes a delivery's engine call; a run that has ended absorbs it, but for a parent correction,
    // which moves an ended run too.
    pub(super) async fn run(
        &self,
        binding: &EpochBinding,
        attribution: DeliveryAttribution,
        work: RunWork,
    ) -> Result<InboundOutcome, InboundDispatchError> {
        let absorbed = work.absorbed();
        let run_ended = || self.absorb_ended(binding, &absorbed, attribution);
        Ok(match work {
            RunWork::Lifecycle {
                change,
                turn_end,
                is_daemon_interrupt_end,
            } => {
                let run_id = change.run_id;
                let change = RunStateChange::from(change);
                let is_answer_left_held = self
                    .settle_held_answer(run_id, RunState::from(change.entry.state()))
                    .await;
                match self
                    .engine
                    .apply_provider_state_change(change, turn_end)
                    .await
                {
                    Ok(written) => {
                        // The report made the run's move, so the held answer settles alone.
                        if is_answer_left_held {
                            self.choices.hold_answer_as_settlement_alone(run_id);
                        }
                        InboundOutcome::Transitioned {
                            state: written.log_resend_failure(run_id).state,
                        }
                    }
                    // The end of a turn the daemon interrupted is expected to find the run ended.
                    Err(error) if is_ended_run_refusal(&error) && is_daemon_interrupt_end => {
                        InboundOutcome::Absorbed {
                            reason: LateEventAbsorbReason::RunEnded,
                        }
                    }
                    Err(error) if is_ended_run_refusal(&error) => run_ended().await?,
                    // A resume can land before the provider's own report of the pause it ends.
                    Err(error) if is_resumed_run_refusal(&error) => {
                        tracing::debug!(
                            error = &error as &(dyn Error + 'static),
                            run_id = %run_id,
                            "the provider's late report on a resumed run was absorbed"
                        );
                        InboundOutcome::Absorbed {
                            reason: LateEventAbsorbReason::RunResumed,
                        }
                    }
                    Err(error) => return Err(error.into()),
                }
            }
            RunWork::Continued { run_id } => {
                match self.engine.continue_run_with_kept_messages(run_id).await? {
                    Some(run) => InboundOutcome::Transitioned { state: run.state },
                    None => run_ended().await?,
                }
            }
            RunWork::ChildRun {
                parent_run_id,
                subagent,
            } => {
                match self
                    .engine
                    .start_provider_subagent_run(parent_run_id, subagent)
                    .await?
                {
                    Some(SubagentRunStart::Running(run_id)) => {
                        InboundOutcome::ChildRunStarted { run_id }
                    }
                    Some(SubagentRunStart::Refused(run_id, reason)) => {
                        InboundOutcome::ChildRunRefused { run_id, reason }
                    }
                    None => run_ended().await?,
                }
            }
            RunWork::ParentCorrected {
                child_run_id,
                parent_run_id,
            } => InboundOutcome::Appended {
                event_id: self
                    .engine
                    .correct_parent_run(child_run_id, parent_run_id)
                    .await?,
            },
            RunWork::Marker { marker } => match self.engine.append_run_marker(marker).await? {
                Some(event_id) => InboundOutcome::Appended { event_id },
                None => run_ended().await?,
            },
            RunWork::Steered {
                run_id,
                turn_number,
                message_id,
            } => match self
                .engine
                .record_steer(run_id, turn_number, message_id)
                .await?
            {
                SteerRecord::Written(event_id) => {
                    // Moved after the write, so the cursor and the log's fold agree: the driver
                    // awaits each delivery, and no cut fences a binding while its turn is open.
                    self.lock_epochs().move_to_next_position(&binding.id)?;
                    InboundOutcome::Appended { event_id }
                }
                SteerRecord::RunEnded => run_ended().await?,
                // An answer or the daemon's own words written into the turn: no warning, since
                // answering a held ask is normal operation.
                SteerRecord::NotSent => InboundOutcome::NotSentByPerson,
            },
        })
    }
}
