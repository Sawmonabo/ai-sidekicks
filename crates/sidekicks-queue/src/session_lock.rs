//! The queue's one lock per session. Every hold of it first tries again to settle what an
//! interrupt's release left unsettled on the session, and each run's end an interrupt held back
//! that no interrupt holds any more; one that fails again is written to the service log and stays
//! for the next hold or the daemon's next start.

use std::sync::{OnceLock, Weak};

use futures::future::BoxFuture;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::keyed_lock::{KeyHold, KeyedLock};

use crate::error::QueueError;

/// Settles again the interrupt releases left unsettled on a session.
pub(crate) trait UnreleasedInterrupts: Send + Sync {
    /// Settles, under `hold`, each interrupt release the held session has left unsettled, clearing
    /// each record once settled, then each run's end an interrupt held back that no interrupt holds
    /// any more; one that fails again stays for the next hold. Fails with the first failure, every
    /// one tried and each later failure written to the service log.
    fn settle_unreleased<'call>(
        &'call self,
        hold: &'call KeyHold<'_, SessionId>,
    ) -> BoxFuture<'call, Result<(), QueueError>>;
}

/// The queue's per-session lock, never the session append lock: a withdraw waits under it.
pub(crate) struct QueueSessionLock {
    lock: KeyedLock<SessionId>,
    // The run queue, which settles the unsettled releases; handed over once it is built.
    unreleased: OnceLock<Weak<dyn UnreleasedInterrupts>>,
}

impl QueueSessionLock {
    /// A lock settling no release until [`QueueSessionLock::settle_with`] hands it the queue.
    pub(crate) fn new() -> Self {
        Self {
            lock: KeyedLock::new(),
            unreleased: OnceLock::new(),
        }
    }

    /// Hands over what settles the unsettled releases at each hold. Called once, by the run
    /// queue's construction.
    pub(crate) fn settle_with(&self, unreleased: Weak<dyn UnreleasedInterrupts>) {
        self.unreleased
            .set(unreleased)
            .expect("the run queue hands itself over once, at its construction");
    }

    /// Waits for `session_id` behind every caller that asked first and answers the hold once the
    /// session's unsettled releases and held-back run ends are settled again; one that fails again
    /// is written to the service log and stays for the next hold.
    pub(crate) async fn hold_session(&self, session_id: SessionId) -> KeyHold<'_, SessionId> {
        let (hold, settled) = self.hold_settled(session_id).await;
        if let Err(error) = settled {
            tracing::error!(
                session_id = %session_id,
                error = &error as &(dyn std::error::Error + 'static),
                "settling again what an interrupt's release left unsettled failed; the session's \
                 next hold settles it again"
            );
        }
        hold
    }

    /// [`QueueSessionLock::hold_session`], answering how the settle of the unsettled releases went
    /// beside the hold.
    pub(crate) async fn hold_settled(
        &self,
        session_id: SessionId,
    ) -> (KeyHold<'_, SessionId>, Result<(), QueueError>) {
        let hold = self.lock.acquire(session_id).await;
        let Some(unreleased) = self.unreleased.get().and_then(Weak::upgrade) else {
            return (hold, Ok(()));
        };
        let settled = unreleased.settle_unreleased(&hold).await;
        (hold, settled)
    }
}
