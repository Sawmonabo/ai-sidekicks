//! Paths held in use, each counted once per hold standing on it, so dropping one of two holds of a
//! path keeps the other: the names the folder moves are using, and the folders a removal is closing.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use sidekicks_std::mutex_lock::lock;

use crate::trust_envelope::is_contained_within;

/// The paths held now, each counted once per hold. Made once and shared by `Arc` with everything
/// that holds or reads one.
#[derive(Debug, Default)]
pub struct PathHolds {
    holds: Mutex<HashMap<PathBuf, usize>>,
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
}

impl Drop for PathHold {
    fn drop(&mut self) {
        let mut holds = lock(&self.holds.holds);
        if let Some(count) = holds.get_mut(&self.path) {
            *count -= 1;
            if *count == 0 {
                holds.remove(&self.path);
            }
        }
    }
}
