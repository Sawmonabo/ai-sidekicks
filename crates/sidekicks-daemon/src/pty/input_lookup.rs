//! How a write naming a session's shell finds that shell's input, which the terminal handler
//! takes and the shell table answers.

use std::sync::Arc;

use futures::future::BoxFuture;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::terminal::TerminalId;

use crate::write::ShellInput;
use sidekicks_ipc::registry::HandlerError;

/// Finds the input of a session's shell at once, or answers the refusal of a write naming no shell,
/// which may wait on a read: `session.notFound` for a session this daemon does not hold and
/// `terminal.notFound` for a shell the session does not have.
pub(crate) type ShellInputLookup = Arc<
    dyn Fn(&SessionId, &TerminalId) -> Result<Arc<ShellInput>, BoxFuture<'static, HandlerError>>
        + Send
        + Sync,
>;
