//! The answers the provider got with no reply back, each held on its run until the provider's word
//! or the run's end settles it. The resolver holds and settles them, and a run's end writes one a
//! report showed the provider took as the choice's settlement in place of `Unanswered`.

use std::collections::HashMap;
use std::sync::Mutex;

use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::driver::run_control::ProviderChoiceAnswer;
use sidekicks_std::mutex_lock::lock;

use super::{ChoiceDialog, PendingChoice};
use crate::run::state_change::RunStateChange;

/// An answer the provider got with no reply back, with the settlement it writes once the provider
/// shows it took it: the move, the request it settles and its event. Once a report moved the run
/// without the answer's move, only the event is written.
pub(super) struct HeldAnswer {
    /// The answer sent to the provider.
    pub(super) answer: ProviderChoiceAnswer,
    /// The run's move the answer makes.
    pub(super) change: RunStateChange,
    /// Whether a report moved the run already, so only the settlement event is left to write.
    pub(super) is_move_made: bool,
    /// The run's session.
    pub(super) session_id: SessionId,
    /// The kind of choice answered.
    pub(super) dialog: ChoiceDialog,
    /// The request the answer settles.
    pub(super) pending: PendingChoice,
    /// The settlement event, with the answering device.
    pub(super) settlement: SessionEvent,
}

/// The settlement of a held answer a report showed the provider took, which a run's end writes in
/// place of the choice's `Unanswered` settlement.
pub(crate) struct MovedAnswer {
    /// The kind of choice answered.
    pub(crate) dialog: ChoiceDialog,
    /// Where the request the answer settles sits in the log.
    pub(crate) requested_sequence: i64,
    /// The settlement event, with the answering device.
    pub(crate) settlement: SessionEvent,
}

/// Each run's answer the provider got with no reply back, until its settle or its run's end. The
/// map is never locked across an await, and no holder panics while it changes it, so a poisoned
/// lock still guards a whole map.
#[derive(Default)]
pub struct HeldChoiceAnswers {
    answers: Mutex<HashMap<RunId, HeldAnswer>>,
}

impl HeldChoiceAnswers {
    /// Holds `held` on its run unless an answer is held there already, which stays: the provider
    /// may have taken that first one.
    pub(super) fn hold(&self, held: HeldAnswer) {
        lock(&self.answers)
            .entry(held.change.run_id)
            .or_insert(held);
    }

    /// Holds `held` on its run in place of any answer held there, for an answer the provider took
    /// whose settlement failed to write.
    pub(super) fn hold_again(&self, held: HeldAnswer) {
        lock(&self.answers).insert(held.change.run_id, held);
    }

    /// The answer held on `run_id`, taken out.
    pub(super) fn take(&self, run_id: RunId) -> Option<HeldAnswer> {
        lock(&self.answers).remove(&run_id)
    }

    /// Leaves the answer held on `run_id`, if any, to settle as its settlement event alone, once a
    /// report moved the run without the answer's move.
    pub(super) fn mark_move_made(&self, run_id: RunId) {
        if let Some(held) = lock(&self.answers).get_mut(&run_id) {
            held.is_move_made = true;
        }
    }

    /// The settlement of the answer held on `run_id` once a report showed the provider took it;
    /// the answer stays held, so a run's end read again still finds it.
    pub(crate) fn moved_answer(&self, run_id: RunId) -> Option<MovedAnswer> {
        lock(&self.answers)
            .get(&run_id)
            .filter(|held| held.is_move_made)
            .map(|held| MovedAnswer {
                dialog: held.dialog,
                requested_sequence: held.pending.sequence,
                settlement: held.settlement.clone(),
            })
    }

    /// The runs an answer is held on.
    pub(super) fn held_run_ids(&self) -> Vec<RunId> {
        lock(&self.answers).keys().copied().collect()
    }

    /// Lets go the answers held on `run_ids`.
    pub(super) fn forget_ended(&self, run_ids: &[RunId]) {
        lock(&self.answers).retain(|run_id, _| !run_ids.contains(run_id));
    }

    /// How many answers are held.
    #[cfg(test)]
    pub(super) fn held_count(&self) -> usize {
        lock(&self.answers).len()
    }
}
