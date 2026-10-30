//! A declared server entry as the probe sends it with `mcp_set_servers`: read into the set's form,
//! a plugin's placeholders and every variable filled as Claude Code fills them on load, or left
//! unsent where the set cannot carry it whole.

use std::collections::BTreeMap;

use serde::Deserialize;
use serde::de::IgnoredAny;
use serde_json::Value;
use sidekicks_contracts::place::PlacedPath;

use super::variables::{ClaudePluginPlaceholders, expand_entry_variables};
use crate::driver::claude::mcp::config::ClaudeDeclaredEntry;
use crate::driver::claude::session::transport::control::ClaudeToolServerEntry;

/// What the probe does with one declared entry: sends it, its variables filled, or reads it
/// `unknown` unsent.
pub(super) enum SentEntry {
    /// The entry as sent.
    Sent(ClaudeToolServerEntry),
    /// The set cannot carry it whole.
    Unsendable,
}

// One server's entry as the person wrote it, values included, with whether it fetches its headers
// from a program or signs in itself, which the set cannot carry. It derives no `Debug`, so
// nothing prints a value.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeDeclaredServer {
    #[serde(rename = "type", default)]
    transport: Option<String>,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    #[serde(default)]
    headers_helper: Option<IgnoredAny>,
    #[serde(default)]
    oauth: Option<IgnoredAny>,
}

/// `declared` as the probe sends it from a process at `root`, a plugin's placeholders and every
/// variable from `environment` filled, or unsendable where the set cannot carry it whole.
pub(super) fn compose_sent_entry(
    declared: ClaudeDeclaredEntry,
    environment: &[(String, String)],
    root: Option<&PlacedPath>,
) -> SentEntry {
    let placeholders = declared
        .plugin_folders
        .map(|folders| ClaudePluginPlaceholders {
            root: folders.root.to_string_lossy().into_owned(),
            data: folders.data.to_string_lossy().into_owned(),
            project: root.map(|root| root.path.as_str().to_owned()),
        });
    match compose_tool_server_entry(declared.entry) {
        Some(entry) => SentEntry::Sent(expand_entry_variables(
            entry,
            environment,
            placeholders.as_ref(),
        )),
        None => SentEntry::Unsendable,
    }
}

/// A declared entry as `mcp_set_servers` takes it, values included; `None` for an entry of another
/// shape, a transport the set has no form for, or one that fetches its headers or signs in itself.
pub(crate) fn compose_tool_server_entry(entry: Value) -> Option<ClaudeToolServerEntry> {
    let declared: ClaudeDeclaredServer = serde_json::from_value(entry).ok()?;
    if declared.headers_helper.is_some() || declared.oauth.is_some() {
        return None;
    }
    match declared.transport.as_deref() {
        None | Some("stdio") => Some(ClaudeToolServerEntry::Stdio {
            command: declared.command?,
            args: declared.args,
            env: declared.env,
        }),
        Some("http") => Some(ClaudeToolServerEntry::Http {
            url: declared.url?,
            headers: declared.headers,
        }),
        Some("sse") => Some(ClaudeToolServerEntry::Sse {
            url: declared.url?,
            headers: declared.headers,
        }),
        Some(_) => None,
    }
}
