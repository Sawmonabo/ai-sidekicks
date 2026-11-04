//! A declared server entry as Claude Code loads it, for the probe's `mcp_set_servers` and the
//! daemon's own reach of a session's server: read into the set's form, a plugin's placeholders and
//! every variable filled as Claude Code fills them on load, or left unsent where the set cannot
//! carry it whole.

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::Value;

use super::variables::{ClaudePluginPlaceholders, expand_entry_variables};
use crate::driver::claude::mcp::config::{
    ClaudeDeclaredEntry, HEADERS_HELPER_MEMBER, HTTP_TYPE, OAUTH_MEMBER, SSE_TYPE, STDIO_TYPE,
};
use crate::driver::claude::session::transport::control::ClaudeToolServerEntry;

/// What becomes of one declared entry sent as Claude Code loads it: sent, its variables filled, or
/// left unsent.
pub(crate) enum SentEntry {
    /// The entry as sent.
    Sent(ClaudeToolServerEntry),
    /// The set cannot carry it whole.
    Unsendable,
}

// One server's entry as the person wrote it, values included. It derives no `Debug`, so nothing
// prints a value.
#[derive(Deserialize)]
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
}

/// `declared` as a process at `project` sends it, a plugin's placeholders and every variable from
/// `environment` filled as Claude Code fills them on load, or unsendable where the set cannot
/// carry it whole.
pub(crate) fn compose_sent_entry(
    declared: ClaudeDeclaredEntry,
    environment: &[(String, String)],
    project: Option<String>,
) -> SentEntry {
    let placeholders = declared
        .plugin_folders
        .map(|folders| ClaudePluginPlaceholders::new(&folders, project));
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
    if is_signed_in_by_provider(&entry) {
        return None;
    }
    let declared: ClaudeDeclaredServer = serde_json::from_value(entry).ok()?;
    match declared.transport.as_deref() {
        None | Some(STDIO_TYPE) => Some(ClaudeToolServerEntry::Stdio {
            command: declared.command?,
            args: declared.args,
            env: declared.env,
        }),
        Some(HTTP_TYPE) => Some(ClaudeToolServerEntry::Http {
            url: declared.url?,
            headers: declared.headers,
        }),
        Some(SSE_TYPE) => Some(ClaudeToolServerEntry::Sse {
            url: declared.url?,
            headers: declared.headers,
        }),
        Some(_) => None,
    }
}

/// Whether `entry` makes its credentials through Claude Code itself: its own sign-in, or a program
/// Claude Code runs for each request's headers. The daemon never holds such credentials.
pub(crate) fn is_signed_in_by_provider(entry: &Value) -> bool {
    [OAUTH_MEMBER, HEADERS_HELPER_MEMBER]
        .iter()
        .any(|member| entry.get(*member).is_some_and(|value| !value.is_null()))
}
