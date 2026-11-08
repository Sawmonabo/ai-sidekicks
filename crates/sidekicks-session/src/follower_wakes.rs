//! The wakes of each followed session's followers, for a store whose followers each read on a task
//! of their own, and the read loop each such task runs: the store raises a session's wakes after
//! each change it writes, and a raise during a read leaves one permit, so a burst of changes costs
//! one more read, never one per change.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use sidekicks_contracts::session::id::SessionId;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_ipc::stream::latest_value::LatestValueOutlet;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::Notify;

/// One follower's wake: raised on each change of its session, awaited by its task.
pub(crate) type FollowerWake = Arc<Notify>;

/// Each followed session's follower wakes.
#[derive(Default)]
pub(crate) struct SessionFollowerWakes {
    by_session: Mutex<HashMap<SessionId, Vec<FollowerWake>>>,
}

impl SessionFollowerWakes {
    /// A new follower's wake for `session_id`, raised by each [`Self::wake`] of it until
    /// [`Self::remove`] drops it.
    pub(crate) fn add(&self, session_id: SessionId) -> FollowerWake {
        let wake: FollowerWake = Arc::new(Notify::new());
        self.lock()
            .entry(session_id)
            .or_default()
            .push(Arc::clone(&wake));
        wake
    }

    /// Stops raising `wake` for `session_id`.
    pub(crate) fn remove(&self, session_id: SessionId, wake: &FollowerWake) {
        let mut by_session = self.lock();
        if let Some(wakes) = by_session.get_mut(&session_id) {
            wakes.retain(|held| !Arc::ptr_eq(held, wake));
            if wakes.is_empty() {
                by_session.remove(&session_id);
            }
        }
    }

    /// Raises every follower wake of `session_id`.
    pub(crate) fn wake(&self, session_id: SessionId) {
        if let Some(wakes) = self.lock().get(&session_id) {
            for wake in wakes {
                wake.notify_one();
            }
        }
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<SessionId, Vec<FollowerWake>>> {
        // The map holds no invariant a panicking holder could break.
        lock(&self.by_session)
    }
}

/// Why a follower's read failed, telling the read pool closing at the daemon's stop, which ends the
/// follow finished, from a failure that ends it with that failure.
pub(crate) trait FollowerReadFailure: Into<HandlerError> {
    /// Whether the read failed because the read pool closed.
    fn is_pool_closed(&self) -> bool;
}

/// Reads with `read` each time `wake` is raised and sends each value through `outlet`, except one
/// `is_unchanged` holds for, until the follow is detached; the read pool closing ends the stream
/// finished, and any other failed read ends it with that failure.
pub(crate) async fn send_each_read<Value, Failure, Reading>(
    wake: FollowerWake,
    outlet: LatestValueOutlet<Value>,
    mut read: impl FnMut() -> Reading,
    mut is_unchanged: impl FnMut(&Value) -> bool,
) where
    Reading: Future<Output = Result<Value, Failure>>,
    Failure: FollowerReadFailure,
{
    loop {
        wake.notified().await;
        match read().await {
            Ok(value) => {
                if !is_unchanged(&value) {
                    outlet.send(value);
                }
            }
            Err(failure) if failure.is_pool_closed() => return,
            Err(failure) => {
                outlet.fail(failure.into());
                return;
            }
        }
    }
}
