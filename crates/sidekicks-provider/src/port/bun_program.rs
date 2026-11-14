//! bun's path, as a driver asks it for a step that runs under bun: the daemon fetches bun for
//! itself at its start, so a step may ask before it is installed.

use std::path::PathBuf;

use futures::future::BoxFuture;

/// Why bun cannot be had: its fetch was refused, and a retry would only be refused again before
/// the next start.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("bun is not installed: {refusal}")]
pub struct BunUnavailable {
    /// The refusal in words, for a log line.
    pub refusal: String,
}

/// The daemon's copy of bun, registered through a `PortRegistration`.
pub trait BunProgram: Send + Sync {
    /// Answers bun's path once it is installed, waiting while the daemon fetches it, and fails at
    /// once with [`BunUnavailable`] once the fetch was refused; the caller bounds the wait.
    fn bun_program(&self) -> BoxFuture<'_, Result<PathBuf, BunUnavailable>>;
}
