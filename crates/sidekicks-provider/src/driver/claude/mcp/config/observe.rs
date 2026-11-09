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

#[cfg(test)]
mod tests {
    use std::fs;

    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::mcp::server::McpWritableBindingRef;
    use sidekicks_contracts::mcp::server::config::McpServerConfigInput;
    use sidekicks_store::events::canonicalizer::canonicalize_json;
    use tokio::time::{Duration, Instant};

    use super::observe_claude_mcp_server;
    use crate::driver::claude::mcp::config::ClaudePersonConfigFiles;
    use crate::driver::claude::mcp::config::compose::compose_claude_mcp_entry;
    use crate::driver::claude::mcp::config::edit::{ClaudeEditTarget, edit_claude_mcp_entry};
    use crate::driver::claude::session::rules::{CLAUDE_SHARED_SETTINGS_FILE, settings_path};
    use crate::driver::mcp_server::write::{McpServerObservedEntry, McpServerWriteOutcome};

    // Compose's entry, written by the edit, is what the observe reads back, in Claude Code's own
    // form, or every landed write would read as a changed entry. Killed by a member compose writes
    // that the observe drops or renames, by `type` added on an added `stdio` entry, and by the
    // program's members kept on a move to an address.
    #[rstest]
    #[case::stdio_add(
        json!({}),
        json!({"transport": "stdio", "command": "npx", "args": ["docs"], "env": {"TOKEN": "t"}}),
        json!({"command": "npx", "args": ["docs"], "env": {"TOKEN": "t"}})
    )]
    #[case::program_to_address(
        json!({"docs": {"command": "npx", "args": ["docs"], "alwaysAllow": ["x"]}}),
        json!({
            "transport": "http",
            "url": "https://example.com/mcp",
            "headers": {"Authorization": "Bearer t"},
        }),
        json!({
            "type": "http",
            "url": "https://example.com/mcp",
            "headers": {"Authorization": "Bearer t"},
            "alwaysAllow": ["x"],
        })
    )]
    #[tokio::test]
    async fn a_composed_entry_reads_back_as_written(
        #[case] servers: Value,
        #[case] config: Value,
        #[case] composed_members: Value,
    ) {
        let home = tempfile::tempdir().unwrap();
        let person = ClaudePersonConfigFiles {
            person_config: home.path().join(".claude.json"),
            user_settings: settings_path(home.path(), CLAUDE_SHARED_SETTINGS_FILE),
        };
        fs::write(
            &person.person_config,
            json!({"numStartups": 3, "mcpServers": servers}).to_string(),
        )
        .unwrap();
        let writable: McpWritableBindingRef = serde_json::from_value(json!({
            "scope": "user", "provider": "claude", "serverName": "docs"
        }))
        .unwrap();
        let binding = writable.binding();
        let config: McpServerConfigInput = serde_json::from_value(config).unwrap();

        let before = observe_claude_mcp_server(&person, home.path(), &binding)
            .await
            .unwrap()
            .entry;
        let composed = compose_claude_mcp_entry(&config, &before).unwrap();
        let outcome = edit_claude_mcp_entry(
            ClaudeEditTarget::PersonConfig {
                path: person.person_config.clone(),
                project_key: None,
            },
            binding.server_name(),
            &composed,
            &before,
            Instant::now() + Duration::from_secs(10),
        )
        .await;
        let observed = observe_claude_mcp_server(&person, home.path(), &binding)
            .await
            .unwrap();

        assert_eq!(
            outcome,
            McpServerWriteOutcome::Applied {
                reload_failure: None
            }
        );
        assert_eq!(Value::Object(composed.members().clone()), composed_members);
        let McpServerObservedEntry::Present(observed_entry) = observed.entry else {
            panic!("the written entry reads back as a declaration");
        };
        assert_eq!(
            canonicalize_json(&Value::Object(composed.members().clone())).unwrap(),
            canonicalize_json(&Value::Object(observed_entry.members().clone())).unwrap()
        );
    }
}
