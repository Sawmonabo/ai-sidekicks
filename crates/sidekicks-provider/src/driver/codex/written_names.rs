//! The forms Codex writes a name in when it writes text.

use crate::driver::written_name::{ServerNameSpelling, WrittenNameForm, WrittenNameKind};

/// Every form Codex writes a name of each kind in: a command as `/name`, a skill as `$name` and a
/// tool server's tool as `mcp__<server>__<tool>`. It writes no agent and no tool server's prompt.
pub(super) const CODEX_WRITTEN_NAME_FORMS: [WrittenNameForm; 3] = [
    WrittenNameForm {
        kind: WrittenNameKind::Command,
        opening: "/",
        joiner: "",
        closing: "",
        server_spelling: ServerNameSpelling::AsConfigured,
    },
    WrittenNameForm {
        kind: WrittenNameKind::Skill,
        opening: "$",
        joiner: "",
        closing: "",
        server_spelling: ServerNameSpelling::AsConfigured,
    },
    WrittenNameForm {
        kind: WrittenNameKind::ToolServerTool,
        opening: "mcp__",
        joiner: "__",
        closing: "",
        server_spelling: ServerNameSpelling::ToolNameSafe,
    },
];
