//! Claude Code's rule for the tool-server names a person may write: letters, digits, hyphens and
//! underscores; the names it keeps for its own servers, matched on the part before a name's first
//! `__`; and the names an object's prototype holds, matched whole. Nothing is case-folded.

use crate::tool_server_name::McpServerNameRule;

/// Claude Code's tool-server name rule.
pub(crate) const CLAUDE_MCP_SERVER_NAMES: McpServerNameRule = McpServerNameRule::new(
    is_allowed_character,
    "letters, digits, hyphens and underscores",
    matched_part,
    &[
        "webagent",
        "claude-code-remote",
        "hearthbot",
        "remote-devices",
        "claude_ai",
        "ccr-email",
        "Claude_Preview",
        "Claude_Browser",
        "claude-in-chrome",
        "Claude_in_Chrome",
        "computer-use",
        "workspace",
        "claude-device",
    ],
    &[
        "__proto__",
        "__defineGetter__",
        "__defineSetter__",
        "__lookupGetter__",
        "__lookupSetter__",
    ],
);

fn is_allowed_character(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
}

// The text before the first `__` of the name followed by `__`, as Claude Code reads a server's
// name out of its tools' names; `None` where that text is empty.
fn matched_part(name: &str) -> Option<&str> {
    let end = name
        .find("__")
        .unwrap_or_else(|| name.strip_suffix('_').unwrap_or(name).len());
    let part = &name[..end];
    (!part.is_empty()).then_some(part)
}
