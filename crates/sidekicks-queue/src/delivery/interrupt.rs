//! An interrupt's hold on its run and its end's writes: while an interrupt of a run is under way
//! nothing more is handed to that run, a hand already inside its driver call is waited out, and at
//! the interrupt's end the messages waiting for the run are returned, placed or left as the
//! interrupt's choice says.

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::InterventionId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_provider::driver::run_control::InterruptPendingChoice;
use sidekicks_session::queue_store::{QueueItemReader, QueueItemRecord, placement_statements};
use sidekicks_session::run::read::RunStateReader;
use sidekicks_std::keyed_lock::KeyHold;
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::database::statement::WriteStatement;
use sidekicks_store::events::session::appender::SessionEventDraft;

use crate::delivery::run_end::stop_message_ends;
use crate::delivery::{DeliveryError, QueueDelivery, reordered_of};
use crate::recorder::QueueRecordError;

/// What one interrupt's release did to its run's hold.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InterruptHoldRelease {
    /// The interrupt held nothing: it was released before, or never held.
    NotHeld,
    /// Another interrupt still holds the run.
    StillHeld,
    /// The run's last hold went; its messages may be handed again.
    Released,
}

/// The interrupt's end writes for the messages waiting for its run.
pub(crate) struct InterruptEndWrites {
    /// The row moves and any draft write, committed with the run's end.
    pub(crate) statements: Vec<WriteStatement>,
    /// The item events, committed before the run's end event.
    pub(crate) preceding_events: Vec<SessionEventDraft>,
    /// The items the writes change, which the caller forgets (a return to the draft) and raises
    /// once they commit.
    pub(crate) changed: Vec<QueueItemRecord>,
    /// Whether no item event records the change (a placement), as `raise_committed` takes it.
    pub(crate) moves_order: bool,
}

impl QueueDelivery {
    /// The interrupt's end writes for the lead messages waiting for `run_id`, called on the
    /// session's chain: `canceled` is given back first, then the messages not handed and not an
    /// opening (a starting run's opening goes with the rest) are returned for `ReturnToDraft` as
    /// the Stop returns them, those canceled put back into the draft whole, placed with
    /// `deliver_first` first for `NextTurn`, and left for `KeepWaiting`. Writes nothing itself.
    /// Fails when a read fails or an event cannot be drafted.
    pub(crate) async fn interrupt_end_writes(
        &self,
        run_id: RunId,
        pending: InterruptPendingChoice,
        deliver_first: Option<QueueItemId>,
        canceled: &[QueueItemId],
    ) -> Result<InterruptEndWrites, DeliveryError> {
        self.give_back(canceled);
        let (run, waiting) = self
            .shared
            .deps
            .pool
            .read(ReadLength::Short, move |reader| {
                let run = RunStateReader::new(reader).read_run(&run_id)?;
                let waiting = QueueItemReader::new(reader).list_waiting_for_run(&run_id)?;
                Ok::<_, DeliveryError>((run, waiting))
            })
            .await?;
        let is_starting = run.is_some_and(|run| run.state == RunState::Starting);
        let lead_waiting = self.lead_waiting(waiting, is_starting);
        let kept: Vec<QueueItemRecord> = {
            let state = self.lock_state();
            lead_waiting
                .into_iter()
                .filter(|item| state.hand_of(&item.id).is_none())
                .collect()
        };
        let now = WireInstant::now();
        match pending {
            InterruptPendingChoice::ReturnToDraft => {
                let ends = stop_message_ends(&kept, &now).map_err(QueueRecordError::from)?;
                Ok(InterruptEndWrites {
                    statements: ends.statements,
                    preceding_events: ends.preceding_events,
                    changed: kept,
                    moves_order: false,
                })
            }
            InterruptPendingChoice::NextTurn => {
                let (statements, changed) = match reordered_of(&kept, deliver_first) {
                    Some(ordered) => (placement_statements(&ordered, &now), ordered),
                    None => (Vec::new(), Vec::new()),
                };
                Ok(InterruptEndWrites {
                    statements,
                    preceding_events: Vec::new(),
                    changed,
                    moves_order: true,
                })
            }
            InterruptPendingChoice::KeepWaiting => Ok(InterruptEndWrites {
                statements: Vec::new(),
                preceding_events: Vec::new(),
                changed: Vec::new(),
                moves_order: false,
            }),
        }
    }

    /// Holds back every hand to `run_id` for the interrupt `intervention_id` until its
    /// [`QueueDelivery::release_interrupt_hold`], a tool boundary's included, and waits out a hand
    /// to it already inside its driver call, never the jobs queued on the chain. Called under
    /// `hold`.
    pub(crate) async fn hold_for_interrupt(
        &self,
        hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
        intervention_id: InterventionId,
    ) {
        self.hold_and_wait_out(
            hold,
            |state| {
                state
                    .interrupt_holds
                    .entry(run_id)
                    .or_default()
                    .insert(intervention_id);
            },
            |in_flight| *in_flight != Some(run_id),
        )
        .await;
    }

    /// Ends the hold the interrupt `intervention_id` took on `run_id`, answering what became of
    /// the run's hold; a second release of one interrupt changes nothing.
    pub(crate) fn release_interrupt_hold(
        &self,
        run_id: RunId,
        intervention_id: InterventionId,
    ) -> InterruptHoldRelease {
        let mut state = self.lock_state();
        let Some(holders) = state.interrupt_holds.get_mut(&run_id) else {
            return InterruptHoldRelease::NotHeld;
        };
        if !holders.remove(&intervention_id) {
            return InterruptHoldRelease::NotHeld;
        }
        if !holders.is_empty() {
            return InterruptHoldRelease::StillHeld;
        }
        state.interrupt_holds.remove(&run_id);
        InterruptHoldRelease::Released
    }

    /// Whether an interrupt of `run_id` is under way.
    pub(crate) fn is_held_for_interrupt(&self, run_id: RunId) -> bool {
        self.lock_state().interrupt_holds.contains_key(&run_id)
    }
}
