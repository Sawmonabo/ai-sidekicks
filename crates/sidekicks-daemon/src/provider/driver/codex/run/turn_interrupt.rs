//! Stopping one Codex turn with `turn/interrupt`, which Codex answers once the turn aborted; the
//! turn's own `turn/completed` follows, which is when it has ended.

use crate::provider::driver::codex::app_server_protocol::TurnInterruptParams;
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::transport::connection::CodexAppServerConnection;

const TURN_INTERRUPT_METHOD: &str = "turn/interrupt";

/// JSON-RPC's invalid-request code, which Codex answers an interrupt of no running turn with.
const INVALID_REQUEST_CODE: i64 = -32600;

/// Codex's words when the conversation runs no turn, or the turn named is the one that just ended.
const NO_ACTIVE_TURN_MESSAGE: &str = "no active turn to interrupt";

/// Asks Codex to stop the turn `turn_id` of the conversation `thread_id`. A turn Codex no longer
/// runs has nothing left to stop, so that refusal answers `Ok`; a turn that is not the one running
/// fails, as every other failure of the request does.
pub(crate) async fn interrupt_codex_turn(
    connection: &CodexAppServerConnection,
    thread_id: &str,
    turn_id: &str,
) -> Result<(), CodexError> {
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
        Ok(_reply) => Ok(()),
        Err(CodexError::ProviderRequest { code, message, .. })
            if code == INVALID_REQUEST_CODE && message.contains(NO_ACTIVE_TURN_MESSAGE) =>
        {
            Ok(())
        }
        Err(error) => Err(error),
    }
}
