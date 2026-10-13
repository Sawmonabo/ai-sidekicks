//! What the daemon reads of the process at the other end of a local connection: its id, and the
//! parent of any process, so the daemon can tell whether it, or a provider service it reaches,
//! started that process.

use std::io;

use futures::future::BoxFuture;
use interprocess::local_socket::tokio::Stream;

/// Reads which process is at the other end of a local connection, and a process's parent.
pub(crate) trait CallerProcessReader: Send + Sync {
    /// The id of the process at the other end of `stream`: on Linux the one that connected (or
    /// listened, on a socket the daemon dialed), as recorded at the connect; on macOS the one that
    /// last used that end. `None` when that end has closed; an error when the system cannot say.
    fn read_peer_process_id(&self, stream: &Stream) -> io::Result<Option<u32>>;

    /// The id of the parent of process `process_id`, `None` when no process has that id; an error
    /// on any other refusal.
    fn read_parent_process_id(&self, process_id: u32) -> BoxFuture<'_, io::Result<Option<u32>>>;
}
