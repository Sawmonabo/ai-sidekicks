//! The forms Codex writes a name in when it writes text.

use crate::driver::written_name::{WrittenNameForm, WrittenNameKind, WrittenNameSpelling};

/// Every form Codex writes a name of each kind in: a command as `/name`, a skill as `$name` and a
/// tool server's tool as `mcp__<server>__<tool>`, each character of the server's name and the
/// tool's outside `A-Za-z0-9_` written as `_`. It writes no agent and no tool server's prompt.
pub(super) const CODEX_WRITTEN_NAME_FORMS: [WrittenNameForm; 3] = [
    WrittenNameForm {
        kind: WrittenNameKind::Command,
        opening: "/",
        joiner: "",
        closing: "",
        server_spelling: WrittenNameSpelling::Unchanged,
        name_spelling: WrittenNameSpelling::Unchanged,
    },
    WrittenNameForm {
        kind: WrittenNameKind::Skill,
        opening: "$",
        joiner: "",
        closing: "",
        server_spelling: WrittenNameSpelling::Unchanged,
        name_spelling: WrittenNameSpelling::Unchanged,
    },
    WrittenNameForm {
        kind: WrittenNameKind::ToolServerTool,
        opening: "mcp__",
        joiner: "__",
        closing: "",
        server_spelling: WrittenNameSpelling::ResponsesToolNameSafe,
        name_spelling: WrittenNameSpelling::ResponsesToolNameSafe,
    },
];
