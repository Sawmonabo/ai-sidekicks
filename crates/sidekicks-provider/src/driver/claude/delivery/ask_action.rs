//! What a Claude Code tool call held on a permission ask would do, read from its tool and input,
//! and the scopes a rule on it may take: Claude Code keeps a rule of every kind for the session and
//! in the project's `.claude/settings.local.json`, but none on a call its own safety check flagged
//! (`suppress_always_allow_rule`), which only a person may allow, each time.

use serde_json::{Map, Value};
use sidekicks_contracts::approval::RememberedScopeKind;
use url::Url;

use crate::driver::claude::delivery::patches::is_claude_file_changing_tool;
use crate::port::permission_ask::ProviderAskAction;
use crate::record_readers::read_non_empty_string;

const CLAUDE_RULE_SCOPES: [RememberedScopeKind; 2] =
    [RememberedScopeKind::Session, RememberedScopeKind::Project];

// The member of an ask Claude Code's safety check sets to offer no standing allow.
const CLAUDE_SUPPRESS_ALLOW_MEMBER: &str = "suppress_always_allow_rule";

/// What a held Claude Code call would do, the scopes a rule on it may take, and whether Claude Code
/// flagged it as one no standing allow may answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeAskReading {
    /// What the call would do.
    pub(crate) action: ProviderAskAction,
    /// The scopes a standing rule on the call may take; none on a flagged call.
    pub(crate) rule_scopes: Vec<RememberedScopeKind>,
    /// Whether Claude Code's own safety check flagged the call.
    pub(crate) is_provider_flagged: bool,
}

/// Reads a held call's action from its `can_use_tool` request's tool name, input and flags; the
/// input and request are untrusted provider output.
pub(crate) fn read_claude_ask_action(
    tool_name: &str,
    input: &Map<String, Value>,
    request: &Map<String, Value>,
) -> ClaudeAskReading {
    let is_provider_flagged = request.get(CLAUDE_SUPPRESS_ALLOW_MEMBER) == Some(&Value::Bool(true));
    ClaudeAskReading {
        action: read_action(tool_name, input),
        rule_scopes: if is_provider_flagged {
            Vec::new()
        } else {
            CLAUDE_RULE_SCOPES.to_vec()
        },
        is_provider_flagged,
    }
}

fn read_action(tool_name: &str, input: &Map<String, Value>) -> ProviderAskAction {
    if tool_name == "Bash"
        && let Some(command) = read_non_empty_string(input, "command")
    {
        return ProviderAskAction::Command {
            command: command.to_owned(),
        };
    }
    if is_claude_file_changing_tool(tool_name)
        && let Some(path) = read_non_empty_string(input, "file_path")
            .or_else(|| read_non_empty_string(input, "notebook_path"))
    {
        return ProviderAskAction::FileChange {
            paths: vec![path.to_owned()],
        };
    }
    if let Some(path) =
        read_path_member(tool_name).and_then(|member| read_non_empty_string(input, member))
    {
        return ProviderAskAction::FileRead {
            path: path.to_owned(),
        };
    }
    if tool_name == "WebFetch"
        && let Some(host) = read_host(input.get("url"))
    {
        return ProviderAskAction::Network { host };
    }
    ProviderAskAction::Tool {
        tool_name: tool_name.to_owned(),
    }
}

// The input member naming the one file a tool reads or the folder it searches under.
fn read_path_member(tool_name: &str) -> Option<&'static str> {
    match tool_name {
        "Read" => Some("file_path"),
        "Glob" | "Grep" => Some("path"),
        _ => None,
    }
}

// The host a fetch names as WHATWG's `hostname` gives it (an IPv6 host in its brackets), or `None`
// for a URL that does not parse or names no host, such as a `file:` URL.
fn read_host(url: Option<&Value>) -> Option<String> {
    let url = Url::parse(url?.as_str()?).ok()?;
    url.host_str()
        .filter(|host| !host.is_empty())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::approval::RememberedScopeKind;

    use super::{ClaudeAskReading, read_claude_ask_action};
    use crate::port::permission_ask::ProviderAskAction;

    #[rstest]
    #[case::a_flagged_command(
        "Bash",
        json!({"command": "rm -rf build"}),
        json!({"suppress_always_allow_rule": true}),
        ClaudeAskReading {
            action: ProviderAskAction::Command { command: "rm -rf build".to_owned() },
            rule_scopes: Vec::new(),
            is_provider_flagged: true,
        }
    )]
    #[case::an_unflagged_command(
        "Bash",
        json!({"command": "rm -rf build"}),
        json!({}),
        ClaudeAskReading {
            action: ProviderAskAction::Command { command: "rm -rf build".to_owned() },
            rule_scopes: vec![RememberedScopeKind::Session, RememberedScopeKind::Project],
            is_provider_flagged: false,
        }
    )]
    fn offers_rule_scopes_only_where_claude_code_keeps_a_rule(
        #[case] tool_name: &str,
        #[case] input: Value,
        #[case] request: Value,
        #[case] expected: ClaudeAskReading,
    ) {
        let input = input.as_object().expect("the input is an object");
        let request = request.as_object().expect("the request is an object");

        assert_eq!(read_claude_ask_action(tool_name, input, request), expected);
    }
}
