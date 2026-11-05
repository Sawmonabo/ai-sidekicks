//! The one `agent.notFound` refusal the agent methods raise for an id that names no agent.

use serde_json::json;
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;

use crate::domain_error::DomainError;

/// The refusal of `agent_id`, which names no agent; the id goes out as the reply's `agentId`
/// field.
pub fn agent_not_found(agent_id: &AgentId) -> DomainError {
    DomainError::new(
        "The session holds no such agent",
        RefusalCode::AgentNotFound,
    )
    .with_detail(json!({ "agentId": agent_id }))
}
