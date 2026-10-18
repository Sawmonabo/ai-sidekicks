//! What a Codex approval would let run, read from its method and params, and the scopes a rule on
//! it may take. A command or a host takes a rule for the session, as `acceptForSession`, where
//! Codex offers that answer, and then one for the project too, in the project's rule file; a change
//! to one file takes the session's alone, since Codex keeps no project rule on a file; input to a
//! running command takes none; a tool server's call takes the session's where Codex says it keeps
//! one. A command is read as the whole line it runs, the one its `<shell> -lc '…'` wrapper hands
//! the shell, and a tool server's call is named as Codex's pre-tool hook names it.

use serde_json::{Map, Value};
use sidekicks_contracts::approval::RememberedScopeKind;

use crate::mcp::tool_name::compose_tool_server_tool_name;
use crate::policy::shell_commands::unwrap_shell_command_line;
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
}

/// Reads one approval from its method and its untrusted params. `changed_paths` are the files the
/// change item a file-change ask names will touch, read from that item, since such an ask names no
/// file itself; no other ask reads them.
pub(crate) fn read_codex_ask_action(
    method: &str,
    params: &Map<String, Value>,
    changed_paths: &[String],
) -> CodexAskReading {
    match method {
        CODEX_COMMAND_APPROVAL_METHOD => read_command_ask(params),
        CODEX_FILE_CHANGE_APPROVAL_METHOD => CodexAskReading {
            action: ProviderAskAction::FileChange {
                paths: changed_paths.to_vec(),
            },
            rule_scopes: if changed_paths.len() == 1 {
                vec![RememberedScopeKind::Session]
            } else {
                Vec::new()
            },
        },
        CODEX_TOOL_SERVER_ELICITATION_METHOD => read_tool_server_ask(method, params),
        _ => CodexAskReading {
            action: ProviderAskAction::Tool {
                tool_name: method.to_owned(),
            },
            rule_scopes: Vec::new(),
        },
    }
}

fn read_command_ask(params: &Map<String, Value>) -> CodexAskReading {
    let command = read_non_empty_string(params, "command").unwrap_or_default();
    if params.get("kind").and_then(Value::as_str) == Some("writeStdin") {
        return CodexAskReading {
            action: ProviderAskAction::CommandInput {
                input: read_written_input(command),
            },
            rule_scopes: Vec::new(),
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
    let action = match host {
        Some(host) => ProviderAskAction::Network {
            host: host.to_owned(),
        },
        // Never the rule words Codex proposes, which may name one command of several or a prefix.
        None => ProviderAskAction::Command {
            command: unwrap_shell_command_line(command).into_owned(),
        },
    };
    CodexAskReading {
        action,
        rule_scopes,
    }
}

// An input ask's command is `write_stdin --session-id <n> <input>`, shell-quoted: its last word is
// the input. A command that does not split is shown as it came, so the card never reads empty.
fn read_written_input(command: &str) -> String {
    shlex::split(command)
        .and_then(|mut words| words.pop())
        .unwrap_or_else(|| command.to_owned())
}

fn read_tool_server_ask(method: &str, params: &Map<String, Value>) -> CodexAskReading {
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
    let server_tool_name = meta.and_then(|meta| read_non_empty_string(meta, "tool_name"));
    let tool_name = match (server_name, server_tool_name) {
        (Some(server_name), Some(server_tool_name)) => {
            compose_tool_server_tool_name(server_name, server_tool_name)
        }
        (Some(server_name), None) => server_name.to_owned(),
        (None, _) => method.to_owned(),
    };
    CodexAskReading {
        action: ProviderAskAction::Tool { tool_name },
        rule_scopes: if keeps_for_session {
            vec![RememberedScopeKind::Session]
        } else {
            Vec::new()
        },
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::approval::RememberedScopeKind;

    use super::{CodexAskReading, read_codex_ask_action};
    use crate::provider::port::permission_ask::ProviderAskAction;

    const BOTH_SCOPES: [RememberedScopeKind; 2] =
        [RememberedScopeKind::Session, RememberedScopeKind::Project];

    #[rstest]
    #[case::input_is_the_last_word(
        "item/commandExecution/requestApproval",
        json!({"kind": "writeStdin", "command": "write_stdin --session-id 3 'yes please'"}),
        &[],
        ProviderAskAction::CommandInput { input: "yes please".to_owned() },
        &[]
    )]
    #[case::an_unsplittable_input_shows_the_command(
        "item/commandExecution/requestApproval",
        json!({"kind": "writeStdin", "command": "write_stdin --session-id 3 'unclosed"}),
        &[],
        ProviderAskAction::CommandInput {
            input: "write_stdin --session-id 3 'unclosed".to_owned()
        },
        &[]
    )]
    #[case::a_wrapped_command_offering_the_session(
        "item/commandExecution/requestApproval",
        json!({"command": "/bin/zsh -lc 'npm test'"}),
        &[],
        ProviderAskAction::Command { command: "npm test".to_owned() },
        &BOTH_SCOPES
    )]
    #[case::a_command_without_accept_for_session(
        "item/commandExecution/requestApproval",
        json!({"command": "npm test", "availableDecisions": ["accept", "decline"]}),
        &[],
        ProviderAskAction::Command { command: "npm test".to_owned() },
        &[]
    )]
    #[case::a_network_ask_with_no_command(
        "item/commandExecution/requestApproval",
        json!({"networkApprovalContext": {"host": "example.com", "protocol": "https"}}),
        &[],
        ProviderAskAction::Network { host: "example.com".to_owned() },
        &BOTH_SCOPES
    )]
    #[case::one_changed_file(
        "item/fileChange/requestApproval",
        json!({"itemId": "change"}),
        &["src/a.rs"],
        ProviderAskAction::FileChange { paths: vec!["src/a.rs".to_owned()] },
        &[RememberedScopeKind::Session]
    )]
    #[case::two_changed_files(
        "item/fileChange/requestApproval",
        json!({"itemId": "change"}),
        &["src/a.rs", "src/b.rs"],
        ProviderAskAction::FileChange {
            paths: vec!["src/a.rs".to_owned(), "src/b.rs".to_owned()]
        },
        &[]
    )]
    #[case::a_tool_call_kept_for_the_session(
        "mcpServer/elicitation/request",
        json!({"serverName": "docs", "_meta": {"persist": ["session", "always"], "tool_name": "search"}}),
        &[],
        ProviderAskAction::Tool { tool_name: "mcp__docs__search".to_owned() },
        &[RememberedScopeKind::Session]
    )]
    fn reads_the_action_and_its_scopes(
        #[case] method: &str,
        #[case] params: Value,
        #[case] changed_paths: &[&str],
        #[case] action: ProviderAskAction,
        #[case] rule_scopes: &[RememberedScopeKind],
    ) {
        let params = params.as_object().expect("the params are an object");
        let changed_paths: Vec<String> =
            changed_paths.iter().map(|&path| path.to_owned()).collect();

        assert_eq!(
            read_codex_ask_action(method, params, &changed_paths),
            CodexAskReading {
                action,
                rule_scopes: rule_scopes.to_vec(),
            }
        );
    }
}
