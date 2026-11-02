//! The capture of what an agent's command changes, as a command channel's follower reaches it: a
//! window opened for each command a wrapper is about to run, before the wrapper is told to go, told
//! whether the command began covered, and closed at the command's end.

use std::error::Error;
use std::path::PathBuf;

use futures::future::BoxFuture;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;

/// One window, as the capture that opened it names it.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct CommandWindowId(String);

impl CommandWindowId {
    /// The window the capture names `id`.
    pub fn new(id: String) -> Self {
        Self(id)
    }

    /// The capture's name for the window.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A command a wrapper is about to run, as its `Starting` tells it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandWindowStart {
    /// The session whose agent runs the command.
    pub session_id: SessionId,
    /// The run the channel's process runs alone; `None` for the session's own process.
    pub apart_run: Option<RunId>,
    /// The wrapper's process id, which names it on the channel while it runs.
    pub party: u32,
    /// The command line the provider gave the wrapper.
    pub command: String,
    /// The file the command's standard output writes to, where it is a file.
    pub stdout_path: Option<PathBuf>,
}

/// How a window's command ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommandWindowEnd {
    /// The wrapper told its command's end: its exit code, or the signal number that ended it.
    Exited {
        /// The command's exit code, absent for a signal's end.
        exit_code: Option<i32>,
        /// The signal that ended the command.
        signal: Option<i32>,
    },
    /// The daemon's stop reached the wrapper before its `Go`, so the command never ran.
    Unrun,
    /// The wrapper's process ended, or its channel stopped being followed, without telling the
    /// command's end.
    Untold,
}

/// Why a window could not be opened.
#[derive(Debug, thiserror::Error)]
#[error("a command's capture window could not be opened: {0}")]
pub struct CommandWindowOpenError(#[source] pub Box<dyn Error + Send + Sync>);

/// The capture around every command an agent runs through the wrapper's line form. A channel's
/// follower makes each call from a task of the window's own, in order, so no call holds up the
/// channel's other records.
pub trait CommandCapture: Send + Sync {
    /// Opens a window for `start`, once the wrapper's `Starting` is read; the wrapper is told to
    /// go once this answers, either way. Fails with [`CommandWindowOpenError`], which leaves the
    /// command to run with no window.
    fn open_window(
        &self,
        start: CommandWindowStart,
    ) -> BoxFuture<'_, Result<CommandWindowId, CommandWindowOpenError>>;

    /// Tells `window` its command began, covered where the wrapper had its `Go` first, once the
    /// wrapper's `Began` is read after the open.
    fn command_began(&self, window: &CommandWindowId, is_covered: bool) -> BoxFuture<'_, ()>;

    /// Closes `window` as `end` says: at the wrapper's `Exited`, at its `Stopped` before it
    /// began, or at its process's end where it told neither. Called once per window, last.
    fn close_window(&self, window: CommandWindowId, end: CommandWindowEnd) -> BoxFuture<'_, ()>;
}
