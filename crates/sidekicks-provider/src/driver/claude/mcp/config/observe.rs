//! The observe of one MCP server binding in Claude Code's own config: the binding's entry as the
//! person's files hold it, values included, held in memory for the write that follows.

use std::path::Path;

use serde_json::Value;
use sidekicks_contracts::mcp::server::McpServerBindingRef;

use super::ClaudePersonConfigFiles;
use super::entry::ClaudeServerEntryReader;
use crate::driver::claude::session::settings_file::ClaudeSettingsReadError;
use crate::driver::mcp_server::write::{McpServerEntry, McpServerObserved, McpServerObservedEntry};

/// What Claude Code's config holds for `binding`, read from the person's files and the plugins in
/// `plugin_home`. Claude Code keeps no switch in its config, so it never answers a switch, and it
/// versions no file and names none. Fails as the config read fails.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Claude driver's MCP write, observe and compose methods call it"
    )
)]
pub(super) async fn observe_claude_mcp_server(
    person: &ClaudePersonConfigFiles,
    plugin_home: &Path,
    binding: &McpServerBindingRef,
) -> Result<McpServerObserved, ClaudeSettingsReadError> {
    let declared = ClaudeServerEntryReader::new(person, plugin_home)
        .read(binding)
        .await?;
    Ok(McpServerObserved {
        entry: observed_entry(declared.as_ref().map(|declared| &declared.entry)),
        config_version: None,
        config_files: Vec::new(),
    })
}

/// The observed form of `entry`, the value a config holds at a binding's place: an object is the
/// declaration, and anything else, or nothing, is absent. The edit reads the file it changes
/// through this too, so its compare and the observe read one entry alike.
pub(super) fn observed_entry(entry: Option<&Value>) -> McpServerObservedEntry {
    match entry.and_then(Value::as_object) {
        Some(members) => {
            McpServerObservedEntry::Present(McpServerEntry::from_members(members.clone()))
        }
        None => McpServerObservedEntry::Absent,
    }
}
