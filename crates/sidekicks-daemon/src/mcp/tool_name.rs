//! The name both providers give a tool server's tool, at their hooks and in their permission rules.

/// The prefix that marks a tool as a tool server's, in every name both providers give one.
pub(crate) const TOOL_SERVER_TOOL_PREFIX: &str = "mcp__";

/// Composes `mcp__<server>__<tool>`. The server and the tool are never split back out of it, since
/// a tool name holding the separator would be ambiguous.
pub(crate) fn compose_tool_server_tool_name(server_name: &str, tool_name: &str) -> String {
    format!("{TOOL_SERVER_TOOL_PREFIX}{server_name}__{tool_name}")
}
