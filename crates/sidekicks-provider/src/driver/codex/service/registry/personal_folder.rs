//! The reads on the person's own Codex folder, and the folder's one hold: a read with no service
//! of the daemon's there to run on starts a short-lived one of its own while it holds the folder,
//! and lets the folder go only once that service has stopped, so at most one such service runs on
//! the folder at a time, whatever it reads.

pub(crate) mod read;
pub(crate) mod stored_turns;

use std::path::PathBuf;
use std::sync::LazyLock;

use sidekicks_std::keyed_lock::KeyedLock;

/// Held per folder from a short-lived service's making until it has stopped.
pub(super) static PERSONAL_FOLDER_HOLDS: LazyLock<KeyedLock<PathBuf>> =
    LazyLock::new(KeyedLock::new);
