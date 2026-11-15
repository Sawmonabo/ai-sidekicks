//! Paths held in use, each counted once per hold standing on it, so dropping one of two holds of a
//! path keeps the other: the names the folder moves are using, the folders a removal is closing,
//! the folders the cleanup is deleting and the folders workspaces are being written into. A waiter
//! is woken each time a path's last hold goes.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use sidekicks_std::mutex_lock::lock;
use tokio::sync::Notify;

use crate::trust_envelope::is_contained_within;

/// The paths held now, each counted once per hold. Made once and shared by `Arc` with everything
/// that holds or reads one.
#[derive(Debug, Default)]
pub struct PathHolds {
    holds: Mutex<HashMap<PathBuf, usize>>,
    // Told each time a path's last hold goes; it wakes only a waiter already registered.
    released: Notify,
}

/// One hold of a path; dropping it lets go of this hold alone, so a canceled task frees its own
/// hold too.
pub(crate) struct PathHold {
    holds: Arc<PathHolds>,
    path: PathBuf,
}

impl PathHolds {
    /// Holds `path` until the answer is dropped.
    pub(crate) fn hold(self: &Arc<Self>, path: &Path) -> PathHold {
        *lock(&self.holds).entry(path.to_path_buf()).or_default() += 1;
        PathHold {
            holds: Arc::clone(self),
            path: path.to_path_buf(),
        }
    }

    /// Whether a hold stands on `path` itself.
    pub(crate) fn is_held(&self, path: &Path) -> bool {
        lock(&self.holds).contains_key(path)
    }

    /// Whether a hold stands on `path` or on a folder it lies inside.
    pub(crate) fn is_held_within(&self, path: &Path) -> bool {
        lock(&self.holds)
            .keys()
            .any(|held| is_contained_within(path, held))
    }

    /// Whether a hold stands on `path`, on a folder it lies inside, or on a path inside it.
    pub(crate) fn is_held_across(&self, path: &Path) -> bool {
        lock(&self.holds)
            .keys()
            .any(|held| is_contained_within(path, held) || is_contained_within(held, path))
    }

    /// Waits until `is_held` reads `false`, reading it again each time a path is let go, and
    /// answers whether it waited at all.
    pub(crate) async fn wait_until_free(&self, is_held: impl Fn(&Self) -> bool) -> bool {
        let mut has_waited = false;
        loop {
            // Registered before the read, so a hold let go between the read and the wait wakes it.
            let released = self.released.notified();
            if !is_held(self) {
                return has_waited;
            }
            released.await;
            has_waited = true;
        }
    }
}

impl Drop for PathHold {
    fn drop(&mut self) {
        let mut holds = lock(&self.holds.holds);
        if let Some(count) = holds.get_mut(&self.path) {
            *count -= 1;
            if *count == 0 {
                holds.remove(&self.path);
                drop(holds);
                self.holds.released.notify_waiters();
            }
        }
    }
}
