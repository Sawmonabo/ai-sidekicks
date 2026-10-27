//! Stopping one Codex turn with `turn/interrupt`, which Codex answers once the turn aborted; the
//! turn's own `turn/completed` follows, which is when it has ended.

use crate::codex::app_server_protocol::TurnInterruptParams;
use crate::codex::session::errors::CodexError;
use crate::codex::transport::connection::CodexAppServerConnection;

const TURN_INTERRUPT_METHOD: &str = "turn/interrupt";

/// JSON-RPC's invalid-request code, which Codex answers an interrupt of no running turn with.
const INVALID_REQUEST_CODE: i64 = -32600;

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
            if code == INVALID_REQUEST_CODE && message.contains(NO_ACTIVE_TURN_MESSAGE) =>
        {
            Ok(CodexTurnInterrupt::AlreadyEnded)
        }
        Err(error) => Err(error),
    }
}
