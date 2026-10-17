//! The Claude Code driver.

use sidekicks_contracts::mcp::server::config::McpTransport;

use crate::provider::driver::ProviderDescriptor;

mod delivery;
mod event_normalizer;
mod hooks;
mod run;
mod session;
mod spent_retries_signal;
mod tools;
mod turn_evidence;

/// Claude Code's fixed facts. Its plan ids read as their own words, and it reads no tool-server
/// declaration member beyond the shared ones.
pub(super) const DESCRIPTOR: ProviderDescriptor = ProviderDescriptor {
    id: "claude",
    name: "Claude Code",
    plan_words: &[],
    built_in_tools: &tools::CLAUDE_BUILT_IN_TOOLS,
    // Its two update switches, set to `1` on every process to keep it pinned, and the
    // screen-reader switch set on a Terminal pane's shell while `Simplify for a screen reader` is
    // on.
    app_set_environment_names: &[
        "DISABLE_AUTOUPDATER",
        "DISABLE_UPDATES",
        "CLAUDE_AX_SCREEN_READER",
    ],
    mcp_transports: &[McpTransport::Stdio, McpTransport::Http, McpTransport::Sse],
    mcp_config_members: &[],
    skill_name_max_length: None,
};
