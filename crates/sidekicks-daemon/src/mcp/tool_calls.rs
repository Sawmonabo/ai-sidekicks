//! The MCP tool-call rule every driver shares: the idempotency floor for a discovered tool, always
//! `manualReconcileOnly`, never derived from its annotation hints, since MCP requires a client to
//! treat annotations as untrusted.

use sidekicks_contracts::provider::driver::tools::IdempotencyClass;

/// The class of every MCP-discovered tool: equal to a driver's default in value but not in rule.
const MCP_DISCOVERED_TOOL_IDEMPOTENCY_CLASS: IdempotencyClass =
    IdempotencyClass::ManualReconcileOnly;

/// Classifies an MCP-discovered tool: always the floor, whatever its annotations claim.
#[expect(
    dead_code,
    reason = "the drivers' MCP tool surfacing reads it when a driver reports the tools a server \
              offers"
)]
pub(crate) const fn classify_mcp_discovered_tool() -> IdempotencyClass {
    MCP_DISCOVERED_TOOL_IDEMPOTENCY_CLASS
}
