//! What a Claude Code tool call does, read from its tool and input when it starts: a search's
//! pattern or query, else what the call's ask would name, else the open kind over its name.

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Map, Value};
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::tool_call::{ToolCallAction, ToolCallActionKind};
use sidekicks_contracts::wire::text::FreeFormText;

use crate::driver::claude::delivery::ask_action::read_action;
use crate::record_readers::read_non_empty_string;
use crate::tool_call_action::{compose_ask_tool_call_action, compose_tool_call_action};

// The members of a call's input an action is read from; any other is skipped unread, so a large
// write's content is never copied.
#[derive(Default, Deserialize)]
struct ClaudeActionInput {
    command: Option<Value>,
    file_path: Option<Value>,
    notebook_path: Option<Value>,
    path: Option<Value>,
    url: Option<Value>,
    pattern: Option<Value>,
    query: Option<Value>,
}

impl ClaudeActionInput {
    // The members read, by their names in the input.
    fn into_members(self) -> Map<String, Value> {
        [
            ("command", self.command),
            ("file_path", self.file_path),
            ("notebook_path", self.notebook_path),
            ("path", self.path),
            ("url", self.url),
            ("pattern", self.pattern),
            ("query", self.query),
        ]
        .into_iter()
        .filter_map(|(member, value)| Some((member.to_owned(), value?)))
        .collect()
    }
}

/// What the call to `tool_name` with `input`, as Claude Code sent it, does; an input that does not
/// read as an object reads as an empty one.
pub(super) fn read_claude_tool_call_action(
    tool_name: &FreeFormText<EVENT_FIELD_MAX_LEN>,
    input: Option<&RawValue>,
) -> ToolCallAction {
    let input = input
        .and_then(|input| serde_json::from_str::<ClaudeActionInput>(input.get()).ok())
        .unwrap_or_default()
        .into_members();
    if let Some(action) = read_search_member(tool_name.as_str())
        .and_then(|member| read_non_empty_string(&input, member))
        .and_then(|subject| compose_tool_call_action(ToolCallActionKind::Search, subject))
    {
        return action;
    }
    compose_ask_tool_call_action(&read_action(tool_name.as_str(), &input), tool_name)
}

// The input member a search names its pattern or its query in.
fn read_search_member(tool_name: &str) -> Option<&'static str> {
    match tool_name {
        "Grep" | "Glob" => Some("pattern"),
        "WebSearch" => Some("query"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::value::RawValue;
    use sidekicks_contracts::provider::tool_call::{ToolCallAction, ToolCallActionKind};
    use sidekicks_contracts::wire::text::FreeFormText;

    use super::read_claude_tool_call_action;

    // Each kind from Claude Code's own tool input, and the open kind with the tool's name for a
    // tool no other kind covers or an input that names no subject. Killed by a kind read from
    // another member, a search read as the folder it searches, a fetch's whole URL kept for its
    // host, a write's path dropped, and an unknown tool given no action.
    #[rstest]
    #[case::a_command(
        "Bash",
        r#"{"command":"npm test","timeout":600}"#,
        ToolCallActionKind::Command,
        "npm test"
    )]
    #[case::a_command_with_no_words("Bash", r#"{"command":""}"#, ToolCallActionKind::Tool, "Bash")]
    #[case::an_edit(
        "Edit",
        r#"{"file_path":"src/auth.ts","old_string":"a","new_string":"b"}"#,
        ToolCallActionKind::FileChange,
        "src/auth.ts"
    )]
    #[case::a_notebook_edit(
        "NotebookEdit",
        r#"{"notebook_path":"nb/plot.ipynb","new_source":"x"}"#,
        ToolCallActionKind::FileChange,
        "nb/plot.ipynb"
    )]
    #[case::a_read(
        "Read",
        r#"{"file_path":"src/main.rs"}"#,
        ToolCallActionKind::FileRead,
        "src/main.rs"
    )]
    #[case::a_grep(
        "Grep",
        r#"{"pattern":"fn main","path":"src"}"#,
        ToolCallActionKind::Search,
        "fn main"
    )]
    #[case::a_glob(
        "Glob",
        r#"{"pattern":"**/*.rs"}"#,
        ToolCallActionKind::Search,
        "**/*.rs"
    )]
    #[case::a_web_search(
        "WebSearch",
        r#"{"query":"serde untagged enum"}"#,
        ToolCallActionKind::Search,
        "serde untagged enum"
    )]
    #[case::a_fetch(
        "WebFetch",
        r#"{"url":"https://docs.rs/serde/latest","prompt":"x"}"#,
        ToolCallActionKind::Network,
        "docs.rs"
    )]
    #[case::a_tool_servers_tool(
        "mcp__docs__search",
        r#"{"q":"auth"}"#,
        ToolCallActionKind::Tool,
        "mcp__docs__search"
    )]
    #[case::an_unknown_tool(
        "Frobnicate",
        r#"{"command":"rm -rf /"}"#,
        ToolCallActionKind::Tool,
        "Frobnicate"
    )]
    #[case::an_input_that_is_no_object("Bash", r#""npm test""#, ToolCallActionKind::Tool, "Bash")]
    fn each_tool_calls_start_records_what_it_does(
        #[case] tool_name: &str,
        #[case] input: &str,
        #[case] kind: ToolCallActionKind,
        #[case] subject: &str,
    ) {
        let tool_name = FreeFormText::new(tool_name.to_owned()).expect("a test tool name fits");
        let input = RawValue::from_string(input.to_owned()).expect("the test input is JSON");

        assert_eq!(
            read_claude_tool_call_action(&tool_name, Some(&input)),
            ToolCallAction {
                kind,
                subject: FreeFormText::new(subject.to_owned()).expect("a test subject fits"),
            }
        );
    }
}
