//! The allow and deny lists Claude Code merges from the user and managed settings.

use serde_json::{Map, Value};
use sidekicks_contracts::mcp::server::McpServerName;
use sidekicks_ipc::redaction::scrub_credentials;

use crate::driver::claude::session::ignored_settings::find_claude_setting;
use crate::driver::mcp_server::read::{McpServerPolicy, McpServerPolicyEntry};

// The settings keys of the allow and deny lists, and the managed switch that keeps only the
// managed allow list.
const ALLOWED_MCP_SERVERS_KEY: &str = "allowedMcpServers";
const DENIED_MCP_SERVERS_KEY: &str = "deniedMcpServers";
const ALLOW_MANAGED_MCP_SERVERS_ONLY_KEY: &str = "allowManagedMcpServersOnly";

/// The allow and deny lists Claude Code merges: the deny list from every file, the allow list from
/// every file unless a managed file keeps only the managed one. An allow list no file sets is
/// absent; one a file sets empty lets nothing load.
pub(super) fn read_server_policy(
    user_settings: Option<&Map<String, Value>>,
    managed_settings: &[Map<String, Value>],
) -> McpServerPolicy {
    let is_managed_allow_list_only = managed_settings.iter().any(|settings| {
        find_claude_setting(settings, &[ALLOW_MANAGED_MCP_SERVERS_ONLY_KEY])
            == Some(&Value::Bool(true))
    });
    let every_file: Vec<&Map<String, Value>> =
        user_settings.into_iter().chain(managed_settings).collect();
    let allow_files: Vec<&Map<String, Value>> = if is_managed_allow_list_only {
        managed_settings.iter().collect()
    } else {
        every_file.clone()
    };
    let mut allowed: Option<Vec<McpServerPolicyEntry>> = None;
    for settings in allow_files {
        if let Some(entries) =
            find_claude_setting(settings, &[ALLOWED_MCP_SERVERS_KEY]).and_then(Value::as_array)
        {
            allowed
                .get_or_insert_with(Vec::new)
                .extend(entries.iter().filter_map(read_policy_entry));
        }
    }
    let denied = every_file
        .into_iter()
        .filter_map(|settings| {
            find_claude_setting(settings, &[DENIED_MCP_SERVERS_KEY]).and_then(Value::as_array)
        })
        .flatten()
        .filter_map(read_policy_entry)
        .collect();
    McpServerPolicy { allowed, denied }
}

// One allow or deny entry: `{"serverName": …}`, `{"serverCommand": […]}` or `{"serverUrl": …}`,
// an address pattern kept as written, its credentials scrubbed.
fn read_policy_entry(entry: &Value) -> Option<McpServerPolicyEntry> {
    if let Some(name) = entry.get("serverName").and_then(Value::as_str) {
        return McpServerName::new(name.to_owned())
            .ok()
            .map(McpServerPolicyEntry::ServerName);
    }
    if let Some(command) = entry.get("serverCommand").and_then(Value::as_array) {
        return command
            .iter()
            .map(|part| part.as_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()
            .map(McpServerPolicyEntry::Command);
    }
    let pattern = entry.get("serverUrl").and_then(Value::as_str)?;
    Some(McpServerPolicyEntry::AddressPattern(scrub_credentials(
        pattern,
    )))
}
