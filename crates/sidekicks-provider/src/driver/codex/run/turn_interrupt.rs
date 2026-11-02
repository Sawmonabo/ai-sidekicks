//! Stopping one Codex turn with `turn/interrupt`, which Codex answers once the turn aborted; the
//! turn's own `turn/completed` follows, which is when it has ended. A conversation's running turn
//! is found as its newest one and stopped the same way.

use crate::driver::codex::app_server_protocol::TurnInterruptParams;
use crate::driver::codex::session::errors::{CODEX_INVALID_REQUEST_CODE, CodexError};
use crate::driver::codex::session::history::read_codex_newest_turn;
use crate::driver::codex::session::owed_turn_ends::is_codex_turn_in_progress;
use crate::driver::codex::transport::connection::CodexAppServerConnection;

/// The method that stops a turn.
pub(crate) const TURN_INTERRUPT_METHOD: &str = "turn/interrupt";

/// Codex's words when the conversation runs no turn, or the turn named is the one that just ended.
const NO_ACTIVE_TURN_MESSAGE: &str = "no active turn to interrupt";

/// How Codex answered an interrupt of a turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CodexTurnInterrupt {
    /// Codex stopped the turn; its `turn/completed` follows, ending `interrupted`.
    Stopped,
    /// The turn had already ended by itself; its `turn/completed` carries that end's own status.
    AlreadyEnded,
}

/// Asks Codex to stop the turn `turn_id` of the conversation `thread_id`, answering whether it
/// stopped it or the turn had already ended. A turn that is not the one running fails, as every
/// other failure of the request does.
pub(crate) async fn interrupt_codex_turn(
    connection: &CodexAppServerConnection,
    thread_id: &str,
    turn_id: &str,
) -> Result<CodexTurnInterrupt, CodexError> {
    let interrupted = connection
        .request(
            TURN_INTERRUPT_METHOD,
            &TurnInterruptParams {
                thread_id: thread_id.to_owned(),
                turn_id: turn_id.to_owned(),
            },
        )
        .await;
    match interrupted {
        Ok(_reply) => Ok(CodexTurnInterrupt::Stopped),
        Err(CodexError::ProviderRequest { code, message, .. })
            if code == CODEX_INVALID_REQUEST_CODE && message.contains(NO_ACTIVE_TURN_MESSAGE) =>
        {
            Ok(CodexTurnInterrupt::AlreadyEnded)
        }
        Err(error) => Err(error),
    }
}

/// Interrupts the running turn of the conversation `thread_id`, read as its newest turn, and
/// answers how Codex took it; `None` where no message has reached the conversation yet, its newest
/// turn has ended, or that turn is `leave`. Fails as the read or the interrupt fails.
pub(crate) async fn interrupt_codex_running_turn(
    connection: &CodexAppServerConnection,
    thread_id: &str,
    leave: Option<&str>,
) -> Result<Option<CodexTurnInterrupt>, CodexError> {
    let Some(newest) = read_codex_newest_turn(connection, thread_id).await? else {
        return Ok(None);
    };
    if !is_codex_turn_in_progress(&newest.turn) || leave == Some(newest.id.as_str()) {
        return Ok(None);
    }
    interrupt_codex_turn(connection, thread_id, &newest.id)
        .await
        .map(Some)
}
