//! Stopping one Codex turn with `turn/interrupt`, which Codex answers once the turn aborted; the
//! turn's own `turn/completed` follows, which is when it has ended. A conversation's running turn
//! is found as its newest one and stopped the same way.

use crate::driver::codex::app_server_protocol::TurnInterruptParams;
use crate::driver::codex::session::errors::{CODEX_INVALID_REQUEST_CODE, CodexError};
use crate::driver::codex::session::history::read_codex_newest_turn;
use crate::driver::codex::session::owed_turn_ends::read_codex_listed_turn;
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::codex::turn_evidence::CodexTurnStatus;

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

/// How a conversation's newest turn stood when its running turn's interrupt was asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CodexRunningTurnInterrupt {
    /// No message has reached the conversation yet, so nothing was sent.
    NoTurn,
    /// Nothing was sent: the newest turn was not running, or was the turn left alone. Holds the
    /// status it was listed with, `None` for a status Codex added.
    Untouched(Option<CodexTurnStatus>),
    /// The newest turn was running, and Codex answered its interrupt so.
    Running(CodexTurnInterrupt),
}

/// Interrupts the running turn of the conversation `thread_id`, read as its newest turn, unless
/// that turn is `leave`, and answers how the turn stood and how Codex took the interrupt. Fails as
/// the read or the interrupt fails.
pub(crate) async fn interrupt_codex_running_turn(
    connection: &CodexAppServerConnection,
    thread_id: &str,
    leave: Option<&str>,
) -> Result<CodexRunningTurnInterrupt, CodexError> {
    let Some(newest) = read_codex_newest_turn(connection, thread_id).await? else {
        return Ok(CodexRunningTurnInterrupt::NoTurn);
    };
    let status = read_codex_listed_turn(&newest.turn).status;
    if status != Some(CodexTurnStatus::InProgress) || leave == Some(newest.id.as_str()) {
        return Ok(CodexRunningTurnInterrupt::Untouched(status));
    }
    interrupt_codex_turn(connection, thread_id, &newest.id)
        .await
        .map(CodexRunningTurnInterrupt::Running)
}
