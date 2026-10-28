//! What the daemon reads of the process at the other end of a local connection, pinned so a later
//! read names the same process: the parent and the responsible process of any pinned process, so
//! the daemon can tell whether it, or a provider service it reaches, started that process, and
//! whether a process is the desktop's signed client.

use std::io;

use futures::future::BoxFuture;
use interprocess::local_socket::tokio::Stream;
use sidekicks_platforms::{ParentProcess, PinnedProcess, ResponsibleProcess, SignatureCheck};

/// A finished peer read: the stream handed back with what the read found, or an error, the stream
/// lost with it, when the read itself could not run.
pub(crate) type PeerRead = io::Result<(Stream, io::Result<Option<PinnedProcess>>)>;

/// Reads which process is at the other end of a local connection, a pinned process's parent and
/// responsible process, and whether a caller is the desktop's signed client.
pub trait CallerProcessReader: Send + Sync {
    /// The process at the other end of `stream`, pinned: on Linux the one that connected (or
    /// listened, on a socket the daemon dialed), as recorded at the connect; on macOS the one that
    /// last used that end. `None` when that end has closed; an error when the system cannot say.
    /// The read hands `stream` back with its answer.
    fn read_peer_process(&self, stream: Stream) -> BoxFuture<'_, PeerRead>;

    /// The parent of `process`, pinned, or why there is none to walk to; an error on any other
    /// refusal.
    fn read_parent_process(
        &self,
        process: PinnedProcess,
    ) -> BoxFuture<'_, io::Result<ParentProcess>>;

    /// The process the system holds responsible for `process`, or that the system keeps none; an
    /// error when the system cannot say.
    fn read_responsible_process(
        &self,
        process: PinnedProcess,
    ) -> BoxFuture<'_, io::Result<ResponsibleProcess>>;

    /// Whether `caller` runs the desktop's signed client helper and `responsible`, the process
    /// responsible for it, the signed app, with the status that said why not; `None` on a daemon
    /// that admits no client by its signature. An error when the system cannot check.
    fn check_desktop_client(
        &self,
        caller: PinnedProcess,
        responsible: PinnedProcess,
    ) -> BoxFuture<'_, io::Result<Option<SignatureCheck>>>;
}
