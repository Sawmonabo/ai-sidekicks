//! The refusals of a request a session's shells cannot serve.

use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::jsonrpc::streaming::SubscriptionId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::terminal::TerminalId;
use sidekicks_ipc::domain_error::DomainError;

/// The refusal of a request naming a shell its session does not have; another session's shell is
/// not told apart from none.
pub fn terminal_not_found(terminal_id: &TerminalId) -> DomainError {
    DomainError::new(
        format!("this session has no shell {}", terminal_id.as_str()),
        RefusalCode::TerminalNotFound,
    )
    .with_detail(json!({ "terminalId": terminal_id }))
}

/// The refusal of a take or write naming a subscription that is not the calling connection's own
/// open output subscription to the shell.
pub(crate) fn output_subscription_not_found(
    terminal_id: &TerminalId,
    output_subscription_id: &SubscriptionId,
) -> DomainError {
    DomainError::new(
        format!(
            "no open output subscription of this connection to shell {}",
            terminal_id.as_str()
        ),
        RefusalCode::TerminalOutputSubscriptionNotFound,
    )
    .with_detail(json!({
        "terminalId": terminal_id,
        "outputSubscriptionId": output_subscription_id,
    }))
}

/// The refusal of `terminal.open` on a chat session, which has no shell.
pub(crate) fn chat_unsupported(session_id: &SessionId) -> DomainError {
    DomainError::new(
        "A chat session has no shell.",
        RefusalCode::TerminalChatUnsupported,
    )
    .with_detail(json!({ "sessionId": session_id }))
}

/// The refusal of `terminal.open` while the daemon's terminals drain at its stop, so no shell's
/// terminal can open; `cause` is the terminals' own words.
pub(crate) fn backend_unavailable(cause: &str) -> DomainError {
    DomainError::new(
        "The background service is stopping, so no shell can start.",
        RefusalCode::TerminalBackendUnavailable,
    )
    .with_detail(json!({ "cause": cause }))
}
