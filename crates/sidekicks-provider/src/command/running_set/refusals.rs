//! The running set's refusals of a person's act on a command.

use serde_json::json;
use sidekicks_contracts::command::CommandId;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_ipc::domain_error::DomainError;

/// The refusal of an act on a command the agent is not waiting on,
/// `agent.command.notInForeground`.
pub(super) fn not_in_foreground(command_id: &CommandId) -> DomainError {
    DomainError::new(
        "The agent is not waiting on this command.",
        RefusalCode::AgentCommandNotInForeground,
    )
    .with_detail(json!({ "commandId": command_id }))
}

/// The refusal of input to a command that takes none and has no prompt open,
/// `agent.command.takesNoInput`.
pub(crate) fn takes_no_input(command_id: &CommandId) -> DomainError {
    DomainError::new(
        "This command takes no input and has no prompt open.",
        RefusalCode::AgentCommandTakesNoInput,
    )
    .with_detail(json!({ "commandId": command_id }))
}
