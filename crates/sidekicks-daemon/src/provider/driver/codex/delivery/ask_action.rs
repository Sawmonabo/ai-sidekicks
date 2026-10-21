//! What a Codex approval would let run, read from its method and params, and the scopes a rule on
//! it may take. A command or a host takes a rule for the session, as `acceptForSession`, where
//! Codex offers that answer, and then one for the project too, in the project's rule file; a change
//! to one file takes the session's alone, since Codex keeps no project rule on a file; input to a
//! running command takes none; a tool server's call takes the session's where Codex says it keeps
//! one and the tool is known, since Codex keeps that allow for the one tool and never the whole
//! server. A command is read as the whole line it runs, the one its `<shell> -lc '…'` wrapper hands
//! the shell, read once on the ask's own shell-line reader for every check, and a tool server's call
//! is named as Codex's pre-tool hook names it.

use serde_json::{Map, Value};
use sidekicks_contracts::approval::RememberedScopeKind;

use crate::mcp::tool_name::compose_tool_server_tool_name;
use crate::policy::background_work::refuse_background_work;
use crate::policy::shell_commands::{ShellLineReader, unwrap_shell_command_line};
use crate::provider::port::permission_ask::ProviderAskAction;
use crate::provider::record_readers::read_non_empty_string;

/// The method Codex asks on before it runs a command, or writes to a running one.
pub(crate) const CODEX_COMMAND_APPROVAL_METHOD: &str = "item/commandExecution/requestApproval";

/// The method Codex asks on before it applies a file change.
pub(crate) const CODEX_FILE_CHANGE_APPROVAL_METHOD: &str = "item/fileChange/requestApproval";

/// The method Codex asks on before a tool server's call, and for a tool server's own question.
pub(crate) const CODEX_TOOL_SERVER_ELICITATION_METHOD: &str = "mcpServer/elicitation/request";

// The answer that keeps an allow for the rest of the conversation, on a command's ask.
const CODEX_SESSION_DECISION: &str = "acceptForSession";

// A tool server's approval names the scopes it keeps an allow for in `_meta.persist`.
const CODEX_PERSIST_SESSION: &str = "session";

/// What a held Codex approval would do, and the scopes a rule on it may take.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexAskReading {
    /// What the held call would do.
    pub(crate) action: ProviderAskAction,
    /// The scopes a standing rule on it may take.
    pub(crate) rule_scopes: Vec<RememberedScopeKind>,
    /// The refusal of a command that starts a provider's background work, read from the line the
    /// ask runs; `None` for every other ask, and for a line not read whole.
    pub(crate) command_refusal: Option<&'static str>,
}

/// Reads one approval from its method and its untrusted params. `changed_paths` are the files the
/// change item a file-change ask names will touch, read from that item, since such an ask names no
/// file itself; `called_tool` is the tool of the one tool call in flight on the ask's thread for its
/// server, where there is exactly one, since Codex's own ask before a tool call names no tool. No
/// other ask reads them. A command's line is read on `reader`, the ask's own, which runs on the
/// daemon-wide shell-line bound's blocking thread.
pub(crate) fn read_codex_ask_action(
    method: &str,
    params: &Map<String, Value>,
    changed_paths: &[String],
    called_tool: Option<&str>,
    reader: &mut ShellLineReader,
) -> CodexAskReading {
    match method {
        CODEX_COMMAND_APPROVAL_METHOD => read_command_ask(params, reader),
        CODEX_FILE_CHANGE_APPROVAL_METHOD => CodexAskReading {
            action: ProviderAskAction::FileChange {
                paths: changed_paths.to_vec(),
            },
            rule_scopes: if changed_paths.len() == 1 {
                vec![RememberedScopeKind::Session]
            } else {
                Vec::new()
            },
            command_refusal: None,
        },
        CODEX_TOOL_SERVER_ELICITATION_METHOD => read_tool_server_ask(method, params, called_tool),
        _ => CodexAskReading {
            action: ProviderAskAction::Tool {
                tool_name: method.to_owned(),
            },
            rule_scopes: Vec::new(),
            command_refusal: None,
        },
    }
}

fn read_command_ask(params: &Map<String, Value>, reader: &mut ShellLineReader) -> CodexAskReading {
    let command = read_non_empty_string(params, "command").unwrap_or_default();
    if params.get("kind").and_then(Value::as_str) == Some("writeStdin") {
        return CodexAskReading {
            action: ProviderAskAction::CommandInput {
                input: read_written_input(command),
            },
            rule_scopes: Vec::new(),
            command_refusal: None,
        };
    }
    // A server that lists no answers offers its whole set, `acceptForSession` among them.
    let keeps_for_session = params
        .get("availableDecisions")
        .and_then(Value::as_array)
        .is_none_or(|decisions| {
            decisions
                .iter()
                .any(|decision| decision.as_str() == Some(CODEX_SESSION_DECISION))
        });
    let rule_scopes = if keeps_for_session {
        vec![RememberedScopeKind::Session, RememberedScopeKind::Project]
    } else {
        Vec::new()
    };
    // A network approval carries no command, so its host is read first.
    let host = params
        .get("networkApprovalContext")
        .and_then(Value::as_object)
        .and_then(|network| read_non_empty_string(network, "host"));
    let (action, command_refusal) = if let Some(host) = host {
        (
            ProviderAskAction::Network {
                host: host.to_owned(),
            },
            None,
        )
    } else {
        // Never the rule words Codex proposes, which may name one command of several or a prefix.
        let reading = reader.read(command);
        (
            ProviderAskAction::Command {
                command: unwrap_shell_command_line(command).into_owned(),
            },
            refuse_background_work(reader, &reading),
        )
    };
    CodexAskReading {
        action,
        rule_scopes,
        command_refusal,
    }
}

// An input ask's command is `write_stdin --session-id <n> <input>`, shell-quoted: its last word is
// the input. A command that does not split is shown as it came, so the card never reads empty.
fn read_written_input(command: &str) -> String {
    shlex::split(command)
        .and_then(|mut words| words.pop())
        .unwrap_or_else(|| command.to_owned())
}

// The tool comes from the ask's own `_meta.tool_name`, which a server's own question carries, else
// from the call in flight; with neither, no rule is offered, since Codex keys the allow it keeps on
// the server and the one tool together.
fn read_tool_server_ask(
    method: &str,
    params: &Map<String, Value>,
    called_tool: Option<&str>,
) -> CodexAskReading {
    let meta = params.get("_meta").and_then(Value::as_object);
    let keeps_for_session = meta
        .and_then(|meta| meta.get("persist"))
        .is_some_and(|persist| match persist {
            Value::String(scope) => scope == CODEX_PERSIST_SESSION,
            Value::Array(scopes) => scopes
                .iter()
                .any(|scope| scope.as_str() == Some(CODEX_PERSIST_SESSION)),
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::Object(_) => false,
        });
    let server_name = read_non_empty_string(params, "serverName");
    let server_tool_name = meta
        .and_then(|meta| read_non_empty_string(meta, "tool_name"))
        .or(called_tool.filter(|tool| !tool.is_empty()));
    let (tool_name, is_tool_known) = match (server_name, server_tool_name) {
        (Some(server_name), Some(server_tool_name)) => (
            compose_tool_server_tool_name(server_name, server_tool_name),
            true,
        ),
        (Some(server_name), None) => (server_name.to_owned(), false),
        (None, _) => (method.to_owned(), false),
    };
    CodexAskReading {
        action: ProviderAskAction::Tool { tool_name },
        rule_scopes: if keeps_for_session && is_tool_known {
            vec![RememberedScopeKind::Session]
        } else {
            Vec::new()
        },
        command_refusal: None,
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::approval::RememberedScopeKind;

    use super::read_codex_ask_action;
    use crate::policy::shell_commands::ShellLineReader;
    use crate::provider::port::permission_ask::ProviderAskAction;

    const BOTH_SCOPES: [RememberedScopeKind; 2] =
        [RememberedScopeKind::Session, RememberedScopeKind::Project];

    #[rstest]
    #[case::input_is_the_last_word(
        "item/commandExecution/requestApproval",
        json!({"kind": "writeStdin", "command": "write_stdin --session-id 3 'yes please'"}),
        &[],
        None,
        ProviderAskAction::CommandInput { input: "yes please".to_owned() },
        &[],
        false
    )]
    #[case::an_unsplittable_input_shows_the_command(
        "item/commandExecution/requestApproval",
        json!({"kind": "writeStdin", "command": "write_stdin --session-id 3 'unclosed"}),
        &[],
        None,
        ProviderAskAction::CommandInput {
            input: "write_stdin --session-id 3 'unclosed".to_owned()
        },
        &[],
        false
    )]
    #[case::a_wrapped_command_offering_the_session(
        "item/commandExecution/requestApproval",
        json!({"command": "/bin/zsh -lc 'npm test'"}),
        &[],
        None,
        ProviderAskAction::Command { command: "npm test".to_owned() },
        &BOTH_SCOPES,
        false
    )]
    #[case::a_command_without_accept_for_session(
        "item/commandExecution/requestApproval",
        json!({"command": "npm test", "availableDecisions": ["accept", "decline"]}),
        &[],
        None,
        ProviderAskAction::Command { command: "npm test".to_owned() },
        &[],
        false
    )]
    #[case::a_wrapped_background_command(
        "item/commandExecution/requestApproval",
        json!({"command": "/bin/zsh -lc 'claude --bg \"fix it\"'"}),
        &[],
        None,
        ProviderAskAction::Command { command: "claude --bg \"fix it\"".to_owned() },
        &BOTH_SCOPES,
        true
    )]
    #[case::an_unterminated_quote_refuses_nothing(
        "item/commandExecution/requestApproval",
        json!({"command": "claude --bg 'unclosed"}),
        &[],
        None,
        ProviderAskAction::Command { command: "claude --bg 'unclosed".to_owned() },
        &BOTH_SCOPES,
        false
    )]
    #[case::a_network_ask_with_no_command(
        "item/commandExecution/requestApproval",
        json!({"networkApprovalContext": {"host": "example.com", "protocol": "https"}}),
        &[],
        None,
        ProviderAskAction::Network { host: "example.com".to_owned() },
        &BOTH_SCOPES,
        false
    )]
    #[case::one_changed_file(
        "item/fileChange/requestApproval",
        json!({"itemId": "change"}),
        &["src/a.rs"],
        None,
        ProviderAskAction::FileChange { paths: vec!["src/a.rs".to_owned()] },
        &[RememberedScopeKind::Session],
        false
    )]
    #[case::two_changed_files(
        "item/fileChange/requestApproval",
        json!({"itemId": "change"}),
        &["src/a.rs", "src/b.rs"],
        None,
        ProviderAskAction::FileChange {
            paths: vec!["src/a.rs".to_owned(), "src/b.rs".to_owned()]
        },
        &[],
        false
    )]
    #[case::a_servers_own_question_naming_its_tool(
        "mcpServer/elicitation/request",
        json!({"serverName": "docs", "_meta": {"persist": ["session", "always"], "tool_name": "search"}}),
        &[],
        None,
        ProviderAskAction::Tool { tool_name: "mcp__docs__search".to_owned() },
        &[RememberedScopeKind::Session],
        false
    )]
    #[case::codexs_tool_call_ask_and_the_call_in_flight(
        "mcpServer/elicitation/request",
        json!({"serverName": "docs", "_meta": {"codex_approval_kind": "mcp_tool_call", "persist": "session"}}),
        &[],
        Some("search"),
        ProviderAskAction::Tool { tool_name: "mcp__docs__search".to_owned() },
        &[RememberedScopeKind::Session],
        false
    )]
    #[case::a_tool_call_ask_whose_tool_is_unknown(
        "mcpServer/elicitation/request",
        json!({"serverName": "docs", "_meta": {"codex_approval_kind": "mcp_tool_call", "persist": "session"}}),
        &[],
        None,
        ProviderAskAction::Tool { tool_name: "docs".to_owned() },
        &[],
        false
    )]
    fn reads_the_action_and_its_scopes(
        #[case] method: &str,
        #[case] params: Value,
        #[case] changed_paths: &[&str],
        #[case] called_tool: Option<&str>,
        #[case] action: ProviderAskAction,
        #[case] rule_scopes: &[RememberedScopeKind],
        #[case] is_refused: bool,
    ) {
        let params = params.as_object().expect("the params are an object");
        let changed_paths: Vec<String> =
            changed_paths.iter().map(|&path| path.to_owned()).collect();
        let mut reader = ShellLineReader::new(4096);

        let reading =
            read_codex_ask_action(method, params, &changed_paths, called_tool, &mut reader);

        assert_eq!(reading.action, action);
        assert_eq!(reading.rule_scopes, rule_scopes);
        assert_eq!(reading.command_refusal.is_some(), is_refused);
    }
}
