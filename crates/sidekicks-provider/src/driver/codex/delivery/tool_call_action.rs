//! What a Codex tool item does, read from the item when it starts: a command's line past its
//! shell's `-lc` wrapper, a change's first file, a viewed image's path, a web search's query, a
//! tool server's tool, else the open kind over the tool's name.

use std::path::PathBuf;

use serde_json::{Map, Value};
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::tool_call::{ToolCallAction, ToolCallActionKind};
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_policy::shell_commands::unwrap_shell_command_line;

use crate::driver::codex::delivery::rows::item_type;
use crate::mcp::tool_name::compose_tool_server_tool_name;
use crate::record_readers::read_non_empty_string;
use crate::tool_call_action::{compose_open_tool_call_action, compose_tool_call_action};

/// What the tool item `item`, named `tool_name` on its row, does; a command's line is read without
/// the `-lc` wrapper of any of `line_shells`, the shells Codex starts a line with, or of a system
/// shell.
pub(super) fn read_codex_tool_call_action(
    item: &Map<String, Value>,
    tool_name: &FreeFormText<EVENT_FIELD_MAX_LEN>,
    line_shells: &[PathBuf],
) -> ToolCallAction {
    let read = |member: &str| read_non_empty_string(item, member);
    let action = match item_type(item) {
        Some("commandExecution") => read("command").and_then(|command| {
            compose_tool_call_action(
                ToolCallActionKind::Command,
                &unwrap_shell_command_line(command, line_shells),
            )
        }),
        // The first change naming a path, read alone, so no patch is read again to name it.
        Some("fileChange") => item
            .get("changes")
            .and_then(Value::as_array)
            .and_then(|changes| {
                changes
                    .iter()
                    .find_map(|change| read_non_empty_string(change.as_object()?, "path"))
            })
            .and_then(|path| compose_tool_call_action(ToolCallActionKind::FileChange, path)),
        Some("imageView") => read("path")
            .and_then(|path| compose_tool_call_action(ToolCallActionKind::FileRead, path)),
        Some("webSearch") => read("query")
            .and_then(|query| compose_tool_call_action(ToolCallActionKind::Search, query)),
        Some("mcpToolCall") => read("server").zip(read("tool")).and_then(|(server, tool)| {
            compose_tool_call_action(
                ToolCallActionKind::Tool,
                &compose_tool_server_tool_name(server, tool),
            )
        }),
        Some(_) | None => None,
    };
    action.unwrap_or_else(|| compose_open_tool_call_action(tool_name))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use rstest::rstest;
    use serde_json::value::RawValue;
    use serde_json::{Value, json};
    use sidekicks_contracts::provider::tool_call::{ToolCallAction, ToolCallActionKind};
    use sidekicks_contracts::wire::text::FreeFormText;

    use crate::driver::codex::delivery::rows::{
        CodexRow, is_codex_tool_item, read_codex_tool_start_row, test_row_run,
    };
    use crate::driver::codex::service::supervisor::routing::read_codex_frame_threads;
    use crate::run::delivery::LateAppendableRow;

    // The shell Codex starts its lines with, outside the system's folders.
    const COMMAND_SHELL: &str = "/opt/homebrew/bin/zsh";

    // Each kind from a Codex item's own members on its start's row, the open kind with the tool's
    // name for an item no other kind covers or one that names no subject, and a spawned helper's
    // ask: a v1 spawn's plain prompt as it came, a v2 spawn's, which Codex hands on encrypted, as
    // the task name its path ends in, in words. Killed by a command kept in its shell's wrapper, a
    // change's file dropped, a tool server's tool named without its server, an unknown tool given
    // no action, a v2 helper given no ask or its path's raw segment, and a v1 prompt reworded.
    #[rstest]
    #[case::a_command_in_a_system_shell(
        json!({"type": "commandExecution", "id": "c-1", "command": "/bin/zsh -lc 'npm test'"}),
        "item/started",
        Some((ToolCallActionKind::Command, "npm test")),
        None
    )]
    #[case::a_command_in_codexs_own_shell(
        json!({
            "type": "commandExecution", "id": "c-2",
            "command": "/opt/homebrew/bin/zsh -lc 'cargo build'",
        }),
        "item/started",
        Some((ToolCallActionKind::Command, "cargo build")),
        None
    )]
    #[case::a_command_with_no_words(
        json!({"type": "commandExecution", "id": "c-3", "command": ""}),
        "item/started",
        Some((ToolCallActionKind::Tool, "commandExecution")),
        None
    )]
    #[case::a_file_change(
        json!({
            "type": "fileChange", "id": "f-1",
            "changes": [
                {"path": "/w/src/auth.ts", "kind": {"type": "update"}, "diff": "-a\n+b"},
                {"path": "/w/src/user.ts", "kind": "add", "diff": "x"},
            ],
        }),
        "item/started",
        Some((ToolCallActionKind::FileChange, "/w/src/auth.ts")),
        None
    )]
    #[case::a_viewed_image(
        json!({"type": "imageView", "id": "i-1", "path": "/w/shot.png"}),
        "item/started",
        Some((ToolCallActionKind::FileRead, "/w/shot.png")),
        None
    )]
    #[case::a_web_search(
        json!({"type": "webSearch", "id": "w-1", "query": "serde untagged enum"}),
        "item/started",
        Some((ToolCallActionKind::Search, "serde untagged enum")),
        None
    )]
    #[case::a_tool_servers_tool(
        json!({
            "type": "mcpToolCall", "id": "m-1", "server": "docs", "tool": "search",
            "arguments": {"q": "auth"},
        }),
        "item/started",
        Some((ToolCallActionKind::Tool, "mcp__docs__search")),
        None
    )]
    #[case::an_unknown_tool(
        json!({"type": "dynamicToolCall", "id": "d-1", "tool": "session_wait", "arguments": {}}),
        "item/started",
        Some((ToolCallActionKind::Tool, "session_wait")),
        None
    )]
    #[case::a_v2_spawns_encrypted_ask_reads_its_task_name(
        json!({
            "type": "subAgentActivity", "id": "s-1", "kind": "started",
            "agentThreadId": "helper", "agentPath": "/root/fix_parser",
        }),
        "item/started",
        None,
        Some("Fix parser")
    )]
    #[case::a_v1_spawns_plain_ask_stands(
        json!({
            "type": "collabAgentToolCall", "id": "v-1", "tool": "spawnAgent",
            "prompt": "fix_parser: Fix the parser.", "receiverThreadIds": ["helper"],
        }),
        "item/completed",
        Some((ToolCallActionKind::Tool, "spawnAgent")),
        Some("fix_parser: Fix the parser.")
    )]
    fn each_items_start_records_what_it_does_and_a_helpers_ask(
        #[case] item: Value,
        #[case] method: &str,
        #[case] action: Option<(ToolCallActionKind, &str)>,
        #[case] ask: Option<&str>,
    ) {
        let item_members = item.as_object().expect("the item is an object");
        let recorded = is_codex_tool_item(item_members).then(|| {
            let row = read_codex_tool_start_row(
                item_members,
                &test_row_run(),
                &[PathBuf::from(COMMAND_SHELL)],
                "item/started",
            )
            .expect("the item opens a row");
            let CodexRow::Late(LateAppendableRow::AgentToolCallInvoked(payload)) = row.event.row
            else {
                panic!("a tool item's start is its call's opening");
            };
            payload.action
        });
        let params = RawValue::from_string(json!({"threadId": "lead", "item": item}).to_string())
            .expect("the params are JSON");
        let threads = read_codex_frame_threads(method, &params);

        assert_eq!(
            recorded.flatten(),
            action.map(|(kind, subject)| ToolCallAction {
                kind,
                subject: FreeFormText::new(subject.to_owned()).expect("a test subject fits"),
            })
        );
        assert_eq!(
            threads
                .spawned_helpers
                .first()
                .and_then(|helper| helper.ask.as_deref()),
            ask
        );
    }
}
