//! The sessions a producer named, waiting for the task that serves them: a follower of every
//! session, which runs on the writer's pump and may not read or write there, or a watch naming the
//! chats whose folders changed. The producer only adds the session here; the task takes every
//! waiting session at once, each named once however many times it was named, and is woken once for
//! any number of adds.

use std::collections::HashSet;
use std::mem;
use std::sync::{Mutex, MutexGuard};

use sidekicks_contracts::session::id::SessionId;
use tokio::sync::Notify;

use sidekicks_std::mutex_lock::lock;

/// The waiting sessions and the wake of the one task that takes them. Holds at most one entry per
/// session.
#[derive(Default)]
pub(crate) struct PendingSessions {
    sessions: Mutex<HashSet<SessionId>>,
    wake: Notify,
}

impl PendingSessions {
    /// Adds `session_id` and wakes the taking task; a session already waiting is kept once.
    pub(crate) fn add(&self, session_id: SessionId) {
        self.lock_sessions().insert(session_id);
        // A wake with no task waiting is kept, so an add made while the task works is not lost.
        self.wake.notify_one();
    }

    /// Every waiting session, taken at once; waits until one is added when none is.
    pub(crate) async fn take(&self) -> HashSet<SessionId> {
        loop {
            let taken = mem::take(&mut *self.lock_sessions());
            if !taken.is_empty() {
                return taken;
            }
            self.wake.notified().await;
        }
    }

    fn lock_sessions(&self) -> MutexGuard<'_, HashSet<SessionId>> {
        // The set holds no invariant a panicking holder could break.
        lock(&self.sessions)
    }
}
