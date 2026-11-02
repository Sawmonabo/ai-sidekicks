//! The forms Claude Code writes a name in when it writes text.

use crate::driver::written_name::{ServerNameSpelling, WrittenNameForm, WrittenNameKind};

/// Every form Claude Code writes a name of each kind in: a command or skill as `/name`, an agent
/// as `@agent-name` or `@"name (agent)"`, a tool server's tool as `mcp__<server>__<tool>`, and its
/// prompt as `/<server>:<prompt> (MCP)` or `/mcp__<server>__<prompt>`.
pub(super) const CLAUDE_WRITTEN_NAME_FORMS: [WrittenNameForm; 7] = [
    WrittenNameForm {
        kind: WrittenNameKind::Command,
        opening: "/",
        joiner: "",
        closing: "",
        server_spelling: ServerNameSpelling::AsConfigured,
    },
    WrittenNameForm {
        kind: WrittenNameKind::Skill,
        opening: "/",
        joiner: "",
        closing: "",
        server_spelling: ServerNameSpelling::AsConfigured,
    },
    WrittenNameForm {
        kind: WrittenNameKind::Agent,
        opening: "@agent-",
        joiner: "",
        closing: "",
        server_spelling: ServerNameSpelling::AsConfigured,
    },
    WrittenNameForm {
        kind: WrittenNameKind::Agent,
        opening: "@\"",
        joiner: "",
        closing: " (agent)\"",
        server_spelling: ServerNameSpelling::AsConfigured,
    },
    WrittenNameForm {
        kind: WrittenNameKind::ToolServerTool,
        opening: "mcp__",
        joiner: "__",
        closing: "",
        server_spelling: ServerNameSpelling::ToolNameSafe,
    },
    WrittenNameForm {
        kind: WrittenNameKind::ToolServerPrompt,
        opening: "/",
        joiner: ":",
        closing: " (MCP)",
        server_spelling: ServerNameSpelling::AsConfigured,
    },
    WrittenNameForm {
        kind: WrittenNameKind::ToolServerPrompt,
        opening: "/mcp__",
        joiner: "__",
        closing: "",
        server_spelling: ServerNameSpelling::ToolNameSafe,
    },
];
