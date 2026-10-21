//! The queue's one lock per session. Every hold of it settles first what an interrupt's release
//! left unsettled on the session, so no send, change, hand, start, run's end or resume of the
//! session goes past an interrupt's choice that a failed release left waiting.

use std::sync::{OnceLock, Weak};

use futures::future::BoxFuture;
use sidekicks_contracts::session::id::SessionId;

use crate::keyed_lock::{KeyHold, KeyedLock};
use crate::queue::error::QueueError;

/// Settles again the interrupt releases left unsettled on a session.
pub(crate) trait UnreleasedInterrupts: Send + Sync {
    /// Settles, under `hold`, each interrupt release the held session has left unsettled, clearing
    /// each record once settled; one that fails again stays recorded. Fails with the first failure,
    /// every release tried and each later failure written to the service log.
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
    /// session's unsettled releases are settled again; one that fails again is written to the
    /// service log and stays recorded for the next hold.
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
