//! The capture of what an agent's command changes, as each leg that runs one reaches it: a window
//! opened for each command an agent is about to run, before the command is let go, told whether
//! the command began covered, and closed at the command's end.

use std::error::Error;

use futures::future::BoxFuture;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;

#[cfg(any(test, feature = "test-support"))]
mod test_support;
#[cfg(any(test, feature = "test-support"))]
pub use test_support::{
    CaptureCall, held_capture, held_capture_with_starts, next_call, no_call, register_held_capture,
    unregistered_capture,
};

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

/// A command an agent is about to run, as the leg that runs it tells it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandWindowStart {
    /// The session whose agent runs the command.
    pub session_id: SessionId,
    /// The run whose process runs the command alone; `None` for the session's own process.
    pub apart_run: Option<RunId>,
    /// The command line the provider gave.
    pub command: String,
    /// The provider's tool call that ran the command, `None` where the leg has none; the wrapper
    /// leg names the call its wrapper paired with.
    pub tool_call_id: Option<ToolCallId>,
}

/// How a window's command ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommandWindowEnd {
    /// The leg told its command's end: the wrapper its exit code or the signal number that ended
    /// it, a shell its end mark's exit code, Claude Code's post-tool hooks zero on success and
    /// otherwise the failure's exit code.
    Exited {
        /// The command's exit code, absent for a signal's end.
        exit_code: Option<i32>,
        /// The signal that ended the command.
        signal: Option<i32>,
    },
    /// The leg ended before its command began, so the command never ran: the wrapper by the
    /// daemon's stop, a signal or a kill while it waited for its `Go`; a shell whose write failed,
    /// or that marked its prompt or exited with no command started; Claude Code's call refused
    /// before it ran, by an ask's refusal, a denial in auto mode or a refusal its stream names.
    Unrun,
    /// The leg ended after its command began without telling the command's end: the wrapper's
    /// process ended or its channel stopped being followed; a shell marked its next prompt with no
    /// end mark, or exited; Claude Code's failure hook named no exit code, or its call's result,
    /// its background task's end or its caller's end came with no post hook.
    Untold,
}

/// Why a window could not be opened.
#[derive(Debug, thiserror::Error)]
pub enum CommandWindowOpenError {
    /// The capture has nothing to cover the command against, so it recorded nothing.
    #[error("a command's capture window was refused: {0}")]
    Refused(CommandWindowRefusal),
    /// A read or write of the capture failed.
    #[error("a command's capture failed")]
    CaptureFailed(#[source] Box<dyn Error + Send + Sync>),
}

/// Why the capture refused a window: no coverage to lose and nothing an undo could put back.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum CommandWindowRefusal {
    /// The session has no checkpoint yet.
    #[error("the session has no checkpoint")]
    NoCheckpoint,
    /// The run has no checkout.
    #[error("the run has no checkout")]
    NoCheckout,
}

/// The capture around every command an agent runs. Each leg makes a window's calls in order, so no
/// call holds up another window's; it calls `command_began` once it let the command go after an
/// open, and only the wrapper leg, whose command can start before its `Go`, tells it uncovered.
pub trait CommandCapture: Send + Sync {
    /// Opens a window for `start`, before the leg lets the command go; the command is let go once
    /// this answers, either way, and a command whose open failed runs with no window.
    /// Answers the window opened where the session's capture can cover the command. Fails
    /// `Refused`, recording nothing, for a session with no checkpoint or a run with no checkout,
    /// where there is no coverage to lose and nothing an undo could put back. Fails `CaptureFailed`
    /// for a failed read or write of the capture once it recorded the command as run uncovered, or,
    /// where that record cannot be written, marked the session's capture failed until its next
    /// capture succeeds, which the undo's preview and its list of uncovered commands show as a
    /// failed capture.
    fn open_window(
        &self,
        start: CommandWindowStart,
    ) -> BoxFuture<'_, Result<CommandWindowId, CommandWindowOpenError>>;

    /// Tells `window` its command began, covered where it was let go after the open; the wrapper
    /// leg tells it once its `Began` is read.
    fn command_began(&self, window: &CommandWindowId, is_covered: bool) -> BoxFuture<'_, ()>;

    /// Closes `window` as `end` says, at the command's end as its leg reads it, unrun where the
    /// leg ended before the command began. Called once per window, last.
    fn close_window(&self, window: CommandWindowId, end: CommandWindowEnd) -> BoxFuture<'_, ()>;

    /// Records a command that ran with no window as run uncovered, under the session's newest
    /// checkpoint and at the time of this call. Records nothing for a session with no checkpoint
    /// or a run with no checkout, as an open is refused; where the record cannot be written, marks
    /// the session's capture failed. Answers at once.
    fn record_uncovered_command(&self, start: CommandWindowStart) -> BoxFuture<'_, ()>;
}
