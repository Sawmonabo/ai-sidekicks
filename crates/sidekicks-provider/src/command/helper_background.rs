//! The person's move of a provider's own helper to the background, the helper target of the
//! background act: the session's driver moves a helper a thread waits on, or answers that none
//! waits on it.

use serde_json::json;
use sidekicks_contracts::agent::tree::ChildHandle;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;

use crate::driver::contract::ProviderDriver;
use crate::driver::contract::error::PROVIDER_CAPABILITY_UNSUPPORTED_MESSAGE;

/// The helper the person moves: its session, the run it runs in and its handle as the agent tree
/// names it, and the provider's own id for it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HelperBackgroundParams {
    /// The session.
    pub session_id: SessionId,
    /// The run the helper runs in.
    pub run_id: RunId,
    /// The helper's handle.
    pub child_handle: ChildHandle,
    /// The helper's id in its provider.
    pub subagent_id: SubagentId,
}

/// Moves the helper `params` names to the background through the session's `driver`. Refused with
/// `agent.command.notInForeground` when no thread waits on it, with
/// `provider.capability.unsupported` where the provider moves no helper, and with the provider's
/// refusal.
pub async fn move_helper_to_background(
    driver: &dyn ProviderDriver,
    params: HelperBackgroundParams,
) -> Result<(), HandlerError> {
    let (run_id, child_handle) = (params.run_id, params.child_handle.clone());
    if driver.move_helper_to_background(params).await? {
        Ok(())
    } else {
        Err(helper_not_in_foreground(run_id, &child_handle).into())
    }
}

/// The refusal of a move of a helper no thread waits on, one that already runs in the background
/// or has finished (`agent.command.notInForeground`).
pub fn helper_not_in_foreground(run_id: RunId, child_handle: &ChildHandle) -> DomainError {
    DomainError::new(
        "The agent is not waiting on this helper.",
        RefusalCode::AgentCommandNotInForeground,
    )
    .with_detail(json!({ "runId": run_id, "childHandle": child_handle }))
}

/// The refusal of a move of the helper `params` names on a provider that moves no helper
/// (`provider.capability.unsupported`).
pub(crate) fn helper_move_unsupported(params: &HelperBackgroundParams) -> DomainError {
    DomainError::new(
        PROVIDER_CAPABILITY_UNSUPPORTED_MESSAGE,
        RefusalCode::ProviderCapabilityUnsupported,
    )
    .with_detail(json!({ "runId": params.run_id, "childHandle": params.child_handle }))
}
