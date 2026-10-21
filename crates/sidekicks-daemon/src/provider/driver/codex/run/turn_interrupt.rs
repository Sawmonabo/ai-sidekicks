//! Stopping one Codex turn with `turn/interrupt`, which Codex answers once it accepts the stop;
//! the turn's own `turn/completed` follows, which is when it has ended.

use crate::provider::driver::codex::app_server_protocol::TurnInterruptParams;
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::transport::connection::CodexAppServerConnection;

const TURN_INTERRUPT_METHOD: &str = "turn/interrupt";

/// Asks Codex to stop the turn `turn_id` of the conversation `thread_id`. Fails as the request
/// fails, a turn Codex no longer runs among its refusals.
pub(crate) async fn interrupt_codex_turn(
    connection: &CodexAppServerConnection,
    thread_id: &str,
    turn_id: &str,
) -> Result<(), CodexError> {
    connection
        .request(
            TURN_INTERRUPT_METHOD,
            &TurnInterruptParams {
                thread_id: thread_id.to_owned(),
                turn_id: turn_id.to_owned(),
            },
        )
        .await
        .map(drop)
}
