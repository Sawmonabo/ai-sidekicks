//! The undo's hold on a session: while an undo stops the session's work, cuts its conversation and
//! puts its files back, nothing of the session is handed, and every hand, start and continue of
//! its lead reads the hold. Each undo holds under its own key, so two undos of one session hold it
//! until both let go, and the last release closes the signal a start that waits to read its opening
//! waits on.

use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_std::keyed_lock::KeyHold;
use tokio::sync::watch;

use crate::delivery::QueueDelivery;

impl QueueDelivery {
    /// Holds back every hand of the session `hold` holds for the undo `undo_key` until its
    /// [`QueueDelivery::release_undo_hold`], and waits out a hand of the session already inside
    /// its driver call, never the jobs queued on the chain, which find the hold and send nothing.
    /// Called under `hold`.
    pub(crate) async fn hold_for_undo(&self, hold: &KeyHold<'_, SessionId>, undo_key: ClientUuid) {
        let session_id = *hold.key();
        self.hold_and_wait_out(
            hold,
            |state| {
                state
                    .undo_holds
                    .entry(session_id)
                    .or_default()
                    .keys
                    .insert(undo_key);
            },
            Option::is_none,
        )
        .await;
    }

    /// Ends the hold the undo `undo_key` took on `session_id`, answering whether the session's last
    /// hold went, so its messages may be handed again and a start waiting on
    /// [`QueueDelivery::undo_release`] goes on; a second release of one undo changes nothing and
    /// answers false.
    pub(crate) fn release_undo_hold(&self, session_id: SessionId, undo_key: &ClientUuid) -> bool {
        let mut state = self.lock_state();
        let Some(holders) = state.undo_holds.get_mut(&session_id) else {
            return false;
        };
        if !holders.keys.remove(undo_key) || !holders.keys.is_empty() {
            return false;
        }
        // Dropping the holders closes their signal.
        state.undo_holds.remove(&session_id);
        true
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
