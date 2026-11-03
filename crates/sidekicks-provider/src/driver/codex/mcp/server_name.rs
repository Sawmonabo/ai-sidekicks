//! Codex's rule for the tool-server names a person may write: letters, digits, hyphens,
//! underscores, colons, at signs, slashes and dots, with its own apps server's name kept, matched
//! whole.

use crate::tool_server_name::McpServerNameRule;

/// Codex's tool-server name rule.
pub(crate) const CODEX_MCP_SERVER_NAMES: McpServerNameRule = McpServerNameRule::new(
    is_allowed_character,
    "letters, digits, hyphens, underscores, colons, at signs, slashes and dots",
    // The whole name: Codex keeps its apps server's name exactly.
    |name| Some(name),
    &["codex_apps"],
    &[],
);

fn is_allowed_character(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':' | '@' | '/' | '.')
}
