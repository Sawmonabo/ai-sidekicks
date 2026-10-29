//! The config a title pass's throwaway conversation runs under, as Codex's own terminal sets it
//! for a structured prompt over transcript text: every feature and tool switch off, web search
//! off, the built-in read-only profile, and each configured MCP server disabled by name: Codex
//! merges an override into the config it loaded, so only each server's `enabled` member changes.

use serde::{Deserialize, Serialize as _};
use serde_json::{Map, Value, json};

use crate::driver::codex::session::errors::CodexError;

/// The switches a title conversation turns off.
const SWITCHES_OFF: [&str; 26] = [
    "features.apps",
    "features.code_mode",
    "features.code_mode_only",
    "features.context_management",
    "features.current_time_reminder",
    "features.deferred_executor",
    "features.enable_fanout",
    "features.goals",
    "features.hooks",
    "features.image_generation",
    "features.memories",
    "features.multi_agent",
    "features.multi_agent_v2",
    "features.plugins",
    "features.request_permissions_tool",
    "features.shell_snapshot",
    "features.shell_tool",
    "features.standalone_web_search",
    "features.token_budget",
    "features.tool_suggest",
    "features.unified_exec",
    "features.view_image",
    "cloud.skills.enabled",
    "skills.include_instructions",
    "tools.experimental_request_user_input.enabled",
    "tools.update_plan.enabled",
];

/// Web search's key, and the value that turns it off.
const WEB_SEARCH_OFF: (&str, &str) = ("web_search", "disabled");

/// The default permission profile's key, and Codex's built-in read-only profile.
const READ_ONLY_PERMISSIONS: (&str, &str) = ("default_permissions", ":read-only");

/// The config table of the MCP servers.
pub(crate) const MCP_SERVERS_KEY: &str = "mcp_servers";

/// The config overrides of a title conversation, each a dotted key and its value, with each of
/// `server_names` disabled under the server table, where a name may hold a dot.
pub(super) fn compose_title_overrides(server_names: &[String]) -> Vec<(String, Value)> {
    let switches = SWITCHES_OFF
        .iter()
        .map(|key| ((*key).to_owned(), Value::Bool(false)));
    let choices = [WEB_SEARCH_OFF, READ_ONLY_PERMISSIONS]
        .into_iter()
        .map(|(key, value)| (key.to_owned(), Value::String(value.to_owned())));
    let servers: Map<String, Value> = server_names
        .iter()
        .map(|name| (name.clone(), json!({ "enabled": false })))
        .collect();
    switches
        .chain(choices)
        .chain([(MCP_SERVERS_KEY.to_owned(), Value::Object(servers))])
        .collect()
}

/// The `-c` arguments that set `overrides` on `codex`, each value written by TOML's own writer.
pub(crate) fn write_exec_overrides(overrides: Vec<(String, Value)>) -> Vec<String> {
    overrides
        .into_iter()
        .flat_map(|(key, value)| {
            let mut written = String::new();
            value
                .serialize(toml::ser::ValueSerializer::new(&mut written))
                .expect("a config override's booleans, strings and tables are TOML values");
            ["-c".to_owned(), format!("{key}={written}")]
        })
        .collect()
}

// One server of `codex mcp list --json`.
#[derive(Deserialize)]
struct ListedServer {
    name: String,
}

/// The MCP servers `codex mcp list --json` printed. Fails with `CodexError::Transport` on a
/// listing that is not a list of named servers.
pub(super) fn read_listed_server_names(listing: &str) -> Result<Vec<String>, CodexError> {
    let servers = serde_json::from_str::<Vec<ListedServer>>(listing).map_err(|error| {
        CodexError::Transport {
            detail: "Codex's MCP server list could not be read.".to_owned(),
            cause: Some(Box::new(error)),
        }
    })?;
    Ok(servers.into_iter().map(|server| server.name).collect())
}

/// The MCP servers the effective config `config` names, its TOML keys at the top.
pub(super) fn read_config_server_names(config: &Map<String, Value>) -> Vec<String> {
    config
        .get(MCP_SERVERS_KEY)
        .and_then(Value::as_object)
        .map(|servers| servers.keys().cloned().collect())
        .unwrap_or_default()
}
