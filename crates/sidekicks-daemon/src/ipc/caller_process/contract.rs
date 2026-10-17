//! What the daemon reads of the process at the other end of a local connection, pinned so a later
//! read names the same process, and the parent of any pinned process, so the daemon can tell
//! whether it, or a provider service it reaches, started that process.

use std::io;

use futures::future::BoxFuture;
use interprocess::local_socket::tokio::Stream;
use sidekicks_platforms::{ParentProcess, PinnedProcess};

/// Reads which process is at the other end of a local connection, and a pinned process's parent.
pub(crate) trait CallerProcessReader: Send + Sync {
    /// The process at the other end of `stream`, pinned: on Linux the one that connected (or
    /// listened, on a socket the daemon dialed), as recorded at the connect; on macOS the one that
    /// last used that end. `None` when that end has closed; an error when the system cannot say.
    fn read_peer_process(&self, stream: &Stream) -> io::Result<Option<PinnedProcess>>;

    /// The parent of `process`, pinned, or why there is none to walk to; an error on any other
    /// refusal.
    fn read_parent_process(
        &self,
        process: PinnedProcess,
    ) -> BoxFuture<'_, io::Result<ParentProcess>>;
}
