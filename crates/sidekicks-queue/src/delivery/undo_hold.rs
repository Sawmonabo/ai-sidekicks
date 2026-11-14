//! The undo's hold on a session: while an undo stops the session's work, cuts its conversation and
//! puts its files back, nothing of the session is handed, and every hand, start and continue of
//! its lead reads the hold. Each undo holds under a hold id of its own, so two undos of one session
//! hold it until both let go, and the last release closes the signal a start that waits to read
//! its opening waits on.

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::keyed_lock::KeyHold;
use tokio::sync::watch;

use crate::delivery::QueueDelivery;
use crate::delivery::state::UndoHoldId;

impl QueueDelivery {
    /// A fresh id for an undo's hold, minted before the hold is taken so a guard that lets it go
    /// exists before it goes in.
    pub(crate) fn mint_undo_hold_id(&self) -> UndoHoldId {
        self.lock_state().mint_undo_hold_id()
    }

    /// Holds back every hand of the session `hold` holds under the undo hold `hold_id` until its
    /// [`QueueDelivery::release_undo_hold`], and waits out a hand of the session already inside
    /// its driver call, never the jobs queued on the chain, which find the hold and send nothing.
    /// Called under `hold`.
    pub(crate) async fn hold_for_undo(&self, hold: &KeyHold<'_, SessionId>, hold_id: UndoHoldId) {
        let session_id = *hold.key();
        self.hold_and_wait_out(
            hold,
            |state| {
                state
                    .undo_holds
                    .entry(session_id)
                    .or_default()
                    .holds
                    .insert(hold_id);
            },
            Option::is_none,
        )
        .await;
    }

    /// Ends the undo hold `hold_id` on `session_id`. Once the session's last hold went, its
    /// messages may be handed again, a start waiting on [`QueueDelivery::undo_release`] goes on,
    /// and the answer is the runs whose resume the holds held back, in the order their resumes
    /// came; `None` while another hold stands, and for a second release of one hold, which changes
    /// nothing.
    pub(crate) fn release_undo_hold(
        &self,
        session_id: SessionId,
        hold_id: UndoHoldId,
    ) -> Option<Vec<RunId>> {
        let mut state = self.lock_state();
        let holders = state.undo_holds.get_mut(&session_id)?;
        if !holders.holds.remove(&hold_id) || !holders.holds.is_empty() {
            return None;
        }
        // Dropping the holders closes their signal.
        state
            .undo_holds
            .remove(&session_id)
            .map(|holders| holders.owed_resumes)
    }

    /// Whether an undo of `session_id` is under way.
    pub(crate) fn is_held_for_undo(&self, session_id: SessionId) -> bool {
        self.lock_state().undo_holds.contains_key(&session_id)
    }

    /// The signal of the undos holding `session_id`, which sends nothing and closes once the last
    /// of them let go; `None` when no undo holds it.
    pub(crate) fn undo_release(&self, session_id: SessionId) -> Option<watch::Receiver<()>> {
        self.lock_state()
            .undo_holds
            .get(&session_id)
            .map(|holders| holders.released.subscribe())
    }
}
