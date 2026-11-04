//! The write of one MCP server to the person's own Codex config: a `user` or emulated `local`
//! binding through Codex's own `config/batchWrite`, against the version the before-read saw; a
//! `project` binding through the project's own file. Only the members the after entry changes are
//! written, so the person's own forms of the rest stay. A landed write is followed by one reload
//! of the running service's servers, whose failure travels inside the applied outcome.

use std::path::Path;

use serde::Deserialize;
use serde_json::{Map, Value};
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName, McpWritableBindingRef};

use crate::driver::codex::app_server_protocol::{
    ConfigBatchWriteParams, ConfigEdit, MergeStrategy,
};
use crate::driver::codex::mcp::config::compose::before_members;
use crate::driver::codex::mcp::config::observe::observe_codex_mcp_server;
use crate::driver::codex::mcp::config::project_file::{
    CodexProjectFile, CodexProjectFileEdit, CodexProjectFileError, CodexProjectServerEdit,
};
use crate::driver::codex::mcp::config::server_entry::ENABLED_MEMBER;
use crate::driver::codex::session::errors::{CODEX_INVALID_REQUEST_CODE, CodexError};
use crate::driver::codex::thread::settings::MCP_SERVERS_KEY;
use crate::driver::codex::transport::connection::{CodexAppServerConnection, read_codex_object};
use crate::driver::mcp_server::write::{
    McpServerObserved, McpServerWrite, McpServerWriteOutcome, McpServerWriteRefusal,
    provider_words_without_values,
};

/// The request that writes several key paths of Codex's user config at once.
const CONFIG_BATCH_WRITE_METHOD: &str = "config/batchWrite";

/// The request that has the running service read its MCP servers from its config again.
const MCP_SERVER_RELOAD_METHOD: &str = "config/mcpServer/reload";

/// The member of a refused write's `data` that names why Codex refused it.
const CONFIG_WRITE_ERROR_CODE_MEMBER: &str = "config_write_error_code";

/// Codex's code for a write whose expected version is no longer the config's.
const CONFIG_VERSION_CONFLICT_CODE: &str = "configVersionConflict";

/// Codex's code for a write after which the config no longer validates.
const CONFIG_VALIDATION_ERROR_CODE: &str = "configValidationError";

/// The JSON-RPC code Codex answers an internal failure with, which may follow a write that landed.
const CODEX_INTERNAL_ERROR_CODE: i64 = -32603;

/// The batch write's statuses for a write that landed.
const LANDED_WRITE_STATUSES: [&str; 2] = ["ok", "okOverridden"];

/// The words for a reload that failed with no words of Codex's own.
const RELOAD_UNANSWERED_WORDS: &str =
    "The Codex service did not reload its MCP servers; it reads the change at its next start.";

/// The words for a switch of a binding whose switch Codex's config does not keep.
const NO_SWITCH_WORDS: &str = "Codex's config keeps no switch for this server.";

/// Writes `write` to the person's own Codex config over `connection`, a service on the person's
/// own Codex folder, against `before`, the binding as observed at `cwd`: the person's home folder
/// for a `user` binding and the project's root, the folder a `project` binding's file is read
/// from, for `project` and `local`. A write that landed is followed by one reload of the service's
/// servers; a failed reload leaves the write applied, with Codex's words for it.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the driver's MCP write, observe and compose methods call it"
    )
)]
pub(super) async fn write_codex_mcp_server(
    connection: &CodexAppServerConnection,
    write: &McpServerWrite,
    before: &McpServerObserved,
    cwd: &Path,
) -> McpServerWriteOutcome {
    let landed = match write {
        McpServerWrite::Upsert { binding, entry } => {
            let before_entry = before_members(&before.entry);
            let differences = member_differences(&before_entry, entry.members());
            match binding {
                McpWritableBindingRef::Project { server_name, .. } => {
                    write_project_file(cwd, server_name, CodexProjectServerEdit::Set(differences))
                        .await
                }
                McpWritableBindingRef::User { server_name, .. }
                | McpWritableBindingRef::Local { server_name, .. } => {
                    let edits = if before_entry.is_empty() {
                        vec![(
                            server_key_path(server_name),
                            Value::Object(entry.members().clone()),
                        )]
                    } else {
                        differences
                            .into_iter()
                            .map(|(member, value)| {
                                (
                                    member_key_path(server_name, &member),
                                    value.unwrap_or(Value::Null),
                                )
                            })
                            .collect()
                    };
                    let binding = McpServerBindingRef::from(binding);
                    write_user_file(connection, edits, &binding, before, cwd).await
                }
            }
        }
        McpServerWrite::Remove { binding } => match binding {
            McpWritableBindingRef::Project { server_name, .. } => {
                write_project_file(cwd, server_name, CodexProjectServerEdit::Remove).await
            }
            McpWritableBindingRef::User { server_name, .. }
            | McpWritableBindingRef::Local { server_name, .. } => {
                let edits = vec![(server_key_path(server_name), Value::Null)];
                let binding = McpServerBindingRef::from(binding);
                write_user_file(connection, edits, &binding, before, cwd).await
            }
        },
        McpServerWrite::SetEnabled {
            binding,
            is_enabled,
        } => match binding {
            McpServerBindingRef::Project { server_name, .. } => {
                let edit = vec![(ENABLED_MEMBER.to_owned(), Some(Value::Bool(*is_enabled)))];
                write_project_file(cwd, server_name, CodexProjectServerEdit::Set(edit)).await
            }
            McpServerBindingRef::User { server_name, .. } => {
                let edits = vec![(
                    member_key_path(server_name, ENABLED_MEMBER),
                    Value::Bool(*is_enabled),
                )];
                write_user_file(connection, edits, binding, before, cwd).await
            }
            // The daemon keeps these switches itself: an emulated `local` entry stays switched
            // off, and a plugin's, a connector's or an administrator's server has no entry here.
            McpServerBindingRef::Local { .. }
            | McpServerBindingRef::Plugin { .. }
            | McpServerBindingRef::Connector { .. }
            | McpServerBindingRef::Managed { .. } => Err(McpServerWriteOutcome::Refused(
                McpServerWriteRefusal::Provider {
                    words: NO_SWITCH_WORDS.to_owned(),
                },
            )),
        },
    };
    match landed {
        Ok(()) => McpServerWriteOutcome::Applied {
            reload_failure: reload_mcp_servers(connection).await,
        },
        Err(outcome) => outcome,
    }
}

/// Each member `after` sets other than `before` holds it, with its value, then each member
/// `before` holds that `after` lacks, with `None`.
fn member_differences(
    before: &Map<String, Value>,
    after: &Map<String, Value>,
) -> Vec<(String, Option<Value>)> {
    let changed = after
        .iter()
        .filter(|(member, value)| before.get(*member) != Some(*value))
        .map(|(member, value)| (member.clone(), Some(value.clone())));
    let removed = before
        .keys()
        .filter(|member| !after.contains_key(*member))
        .map(|member| (member.clone(), None));
    changed.chain(removed).collect()
}

/// The key path of `server_name`'s entry, the name quoted so a `.` in it stays in the name.
fn server_key_path(server_name: &McpServerName) -> String {
    let escaped = server_name
        .as_str()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    format!("{MCP_SERVERS_KEY}.\"{escaped}\"")
}

/// The key path of `member` in `server_name`'s entry.
fn member_key_path(server_name: &McpServerName, member: &str) -> String {
    format!("{}.{member}", server_key_path(server_name))
}

/// Sends `edits` as one `config/batchWrite` of the user config, each replacing what its key path
/// holds, against `before`'s version. Ends with the outcome for a write that did not surely land.
async fn write_user_file(
    connection: &CodexAppServerConnection,
    edits: Vec<(String, Value)>,
    binding: &McpServerBindingRef,
    before: &McpServerObserved,
    cwd: &Path,
) -> Result<(), McpServerWriteOutcome> {
    let params = ConfigBatchWriteParams {
        edits: edits
            .into_iter()
            .map(|(key_path, value)| ConfigEdit {
                key_path,
                merge_strategy: MergeStrategy::Replace,
                value,
            })
            .collect(),
        expected_version: before.config_version.clone(),
        file_path: None,
        reload_user_config: None,
    };
    match connection.request(CONFIG_BATCH_WRITE_METHOD, &params).await {
        Ok(reply) => match read_codex_object::<BatchWriteReply>(reply.get()) {
            Some(reply) if LANDED_WRITE_STATUSES.contains(&reply.status.as_str()) => Ok(()),
            // A reply that does not read as a landed write leaves the write's fate unknown.
            Some(_) | None => Err(McpServerWriteOutcome::Unknown),
        },
        Err(error) => Err(batch_write_failure(connection, error, binding, before, cwd).await),
    }
}

/// The batch write's reply, by the status it names.
#[derive(Deserialize)]
struct BatchWriteReply {
    /// Whether the write landed as written or under an override.
    status: String,
}

/// The outcome of a batch write that failed with `error`. A version conflict reads the config
/// once more at `cwd` for the version it holds now; nothing else is sent.
async fn batch_write_failure(
    connection: &CodexAppServerConnection,
    error: CodexError,
    binding: &McpServerBindingRef,
    before: &McpServerObserved,
    cwd: &Path,
) -> McpServerWriteOutcome {
    if matches!(error, CodexError::Unanswered { .. }) {
        return McpServerWriteOutcome::Unknown;
    }
    let CodexError::ProviderRequest {
        code,
        message,
        data,
        ..
    } = &error
    else {
        return refused_by_provider(&error.to_string());
    };
    if *code == CODEX_INTERNAL_ERROR_CODE {
        return McpServerWriteOutcome::Unknown;
    }
    let write_error_code = data
        .as_deref()
        .and_then(|data| data.get(CONFIG_WRITE_ERROR_CODE_MEMBER))
        .and_then(Value::as_str)
        .filter(|_code| *code == CODEX_INVALID_REQUEST_CODE);
    let words = provider_words_without_values(message);
    match write_error_code {
        Some(CONFIG_VERSION_CONFLICT_CODE) => {
            let Some(expected_version) = before.config_version.clone() else {
                return McpServerWriteOutcome::Refused(McpServerWriteRefusal::Provider { words });
            };
            match observe_codex_mcp_server(connection, binding, cwd).await {
                Ok(McpServerObserved {
                    config_version: Some(current_version),
                    ..
                }) => McpServerWriteOutcome::Refused(McpServerWriteRefusal::StaleVersion {
                    expected_version,
                    current_version,
                }),
                Ok(_) | Err(_) => {
                    McpServerWriteOutcome::Refused(McpServerWriteRefusal::Provider { words })
                }
            }
        }
        Some(CONFIG_VALIDATION_ERROR_CODE) => {
            McpServerWriteOutcome::Refused(if names_entry(message, binding.server_name()) {
                McpServerWriteRefusal::EntryInvalid { words }
            } else {
                McpServerWriteRefusal::ConfigFileInvalid { words }
            })
        }
        Some(_) | None => McpServerWriteOutcome::Refused(McpServerWriteRefusal::Provider { words }),
    }
}

/// Whether Codex's validation `message` faults a member of `server_name`'s own entry: it names
/// `mcp_servers.<name>` followed by `.` or the closing backtick.
fn names_entry(message: &str, server_name: &McpServerName) -> bool {
    let entry_path = format!("{MCP_SERVERS_KEY}.{}", server_name.as_str());
    message.match_indices(&entry_path).any(|(at, _path)| {
        matches!(
            message[at + entry_path.len()..].chars().next(),
            Some('.' | '`')
        )
    })
}

/// Applies `edit` to `server_name`'s table in the project config under `project_root`. Ends with
/// the outcome for an edit that did not land.
async fn write_project_file(
    project_root: &Path,
    server_name: &McpServerName,
    edit: CodexProjectServerEdit,
) -> Result<(), McpServerWriteOutcome> {
    let file = CodexProjectFile::read(project_root)
        .await
        .map_err(|error| project_file_failure(&error))?;
    match file
        .edit_server(server_name, edit)
        .await
        .map_err(|error| project_file_failure(&error))?
    {
        CodexProjectFileEdit::Written | CodexProjectFileEdit::Unchanged => Ok(()),
        CodexProjectFileEdit::FileChanged => Err(McpServerWriteOutcome::Refused(
            McpServerWriteRefusal::ProjectFileChanged,
        )),
    }
}

/// The outcome of a project config read or edit that failed with `error`.
fn project_file_failure(error: &CodexProjectFileError) -> McpServerWriteOutcome {
    let words = provider_words_without_values(&error.to_string());
    McpServerWriteOutcome::Refused(match error {
        CodexProjectFileError::NotToml { .. }
        | CodexProjectFileError::ServersNotATable
        | CodexProjectFileError::ServerEntryNotATable => {
            McpServerWriteRefusal::ConfigFileInvalid { words }
        }
        CodexProjectFileError::UnwritableValue { .. } => {
            McpServerWriteRefusal::EntryInvalid { words }
        }
        // The task may have ended after the file was written.
        CodexProjectFileError::Interrupted(_) => return McpServerWriteOutcome::Unknown,
        CodexProjectFileError::Read(_)
        | CodexProjectFileError::DanglingLink
        | CodexProjectFileError::Folder(_)
        | CodexProjectFileError::Write(_)
        | CodexProjectFileError::Create(_) => McpServerWriteRefusal::Provider { words },
    })
}

/// A refusal in the provider's `words`, with no config value.
fn refused_by_provider(words: &str) -> McpServerWriteOutcome {
    McpServerWriteOutcome::Refused(McpServerWriteRefusal::Provider {
        words: provider_words_without_values(words),
    })
}

/// Has the service read its MCP servers again; `None` where it did, else why it did not, in
/// Codex's words where it answered with some. Nothing is retried.
async fn reload_mcp_servers(connection: &CodexAppServerConnection) -> Option<String> {
    let error = connection
        .request(MCP_SERVER_RELOAD_METHOD, &())
        .await
        .err()?;
    Some(
        if let CodexError::ProviderRequest { message, .. } = &error {
            provider_words_without_values(message)
        } else {
            RELOAD_UNANSWERED_WORDS.to_owned()
        },
    )
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use rstest::rstest;
    use serde_json::{Map, Value, json};
    use sidekicks_contracts::mcp::server::McpWritableBindingRef;
    use sidekicks_contracts::mcp::server::config::McpServerConfigInput;

    use super::write_codex_mcp_server;
    use crate::driver::codex::mcp::config::compose::compose_codex_mcp_entry;
    use crate::driver::codex::session::detached_conversation::CodexDetachedFrames;
    use crate::driver::codex::transport::connection::scripted_service::{
        ScriptedService, connect_scripted_service,
    };
    use crate::driver::codex::transport::connection::{
        CodexAppServerConnection, CodexConnectionHandlers,
    };
    use crate::driver::mcp_server::write::{
        McpServerEntry, McpServerObserved, McpServerObservedEntry, McpServerWrite,
        McpServerWriteOutcome, McpServerWriteRefusal,
    };

    const MESSAGE_LIMIT: usize = 1 << 20;
    const HOME: &str = "/home/person";
    const SECRET: &str = "SECRET-STRING";

    fn scripted_connection() -> (CodexAppServerConnection, ScriptedService) {
        let (events, _frames) = CodexDetachedFrames::new();
        connect_scripted_service(
            MESSAGE_LIMIT,
            CodexConnectionHandlers {
                events,
                responder: None,
                token_refresher: None,
            },
        )
    }

    fn user_binding(server_name: &str) -> McpWritableBindingRef {
        serde_json::from_value(json!({
            "scope": "user", "provider": "codex", "serverName": server_name,
        }))
        .expect("the test's binding reads")
    }

    fn members(value: Value) -> Map<String, Value> {
        serde_json::from_value(value).expect("the test's entry is an object")
    }

    fn observed(entry: Value) -> McpServerObserved {
        McpServerObserved {
            entry: McpServerObservedEntry::Present(McpServerEntry::from_members(members(entry))),
            config_version: Some("sha256:old".to_owned()),
            config_files: vec![format!("{HOME}/.codex/config.toml")],
        }
    }

    fn refusal(sent: &Value, code: i64, message: &str, data: &Value) -> Value {
        json!({
            "jsonrpc": "2.0",
            "id": sent["id"],
            "error": { "code": code, "message": message, "data": data },
        })
    }

    // Reads the batch write sent next and answers that it landed.
    async fn answer_landed_write(script: &mut ScriptedService) -> Value {
        let sent = script.next_sent().await;
        assert_eq!(sent["method"], "config/batchWrite", "{sent}");
        script.answer(
            &sent,
            &json!({
                "status": "ok", "version": "sha256:new",
                "filePath": format!("{HOME}/.codex/config.toml"),
            }),
        );
        sent
    }

    // The batch write's edits by key path, each checked to replace what its path holds.
    fn edits_by_path(sent: &Value) -> Map<String, Value> {
        sent["params"]["edits"]
            .as_array()
            .expect("the write sends its edits")
            .iter()
            .map(|edit| {
                assert_eq!(edit["mergeStrategy"], "replace", "{edit}");
                let path = edit["keyPath"].as_str().expect("an edit names its path");
                (path.to_owned(), edit["value"].clone())
            })
            .collect()
    }

    // Killed by a whole-entry replace, an unquoted dotted name, no reload, `{}` params, a failed
    // reload dropped or read as unknown, a second reload, and the reload's raw words.
    #[rstest]
    #[case::reloaded(None)]
    #[case::reload_failed(Some(-32603))]
    #[tokio::test]
    async fn an_update_writes_each_changed_member_then_reloads_once(
        #[case] reload_error: Option<i64>,
    ) {
        let (connection, mut script) = scripted_connection();
        let before = observed(json!({ "command": "npx", "args": ["docs@1"], "enabled": true }));
        let write = McpServerWrite::Upsert {
            binding: user_binding("docs.v2"),
            entry: McpServerEntry::from_members(members(
                json!({ "command": "npx", "args": ["docs@2"], "enabled": true }),
            )),
        };
        let script_run = async {
            let sent = answer_landed_write(&mut script).await;
            let reload = script.next_sent().await;
            match reload_error {
                None => script.answer(&reload, &json!({})),
                Some(code) => script.send(&refusal(
                    &reload,
                    code,
                    &format!("reloading failed at \"{SECRET}\""),
                    &Value::Null,
                )),
            }
            (sent, reload)
        };
        let (outcome, (sent, reload)) = tokio::join!(
            write_codex_mcp_server(&connection, &write, &before, Path::new(HOME)),
            script_run,
        );
        assert_eq!(
            edits_by_path(&sent),
            members(json!({ "mcp_servers.\"docs.v2\".args": ["docs@2"] }))
        );
        assert_eq!(sent["params"]["expectedVersion"], "sha256:old");
        assert_eq!(reload["method"], "config/mcpServer/reload");
        assert_eq!(reload["params"], Value::Null, "{reload}");
        let McpServerWriteOutcome::Applied { reload_failure } = outcome else {
            panic!("the write landed: {outcome:?}");
        };
        if reload_error.is_none() {
            assert_eq!(reload_failure, None);
        } else {
            let words = reload_failure.expect("a failed reload carries its words");
            assert!(!words.contains(SECRET), "{words}");
        }
        assert!(
            script.sent.try_recv().is_err(),
            "nothing follows the reload"
        );
    }

    // Killed by a composed entry that keeps the other transport's members either way.
    #[rstest]
    #[case::program_to_address(
        json!({
            "command": "npx", "args": ["docs"], "env": { "TOKEN": "t" }, "env_vars": ["HOME"],
            "cwd": "/work", "enabled": true,
        }),
        json!({ "transport": "http", "url": "https://docs.example.com/mcp" }),
        &["command", "args", "env", "env_vars", "cwd"],
    )]
    #[case::address_to_program(
        json!({
            "url": "https://docs.example.com/mcp", "bearer_token_env_var": "DOCS_TOKEN",
            "http_headers": { "X-Team": "a" }, "env_http_headers": { "X-Key": "KEY" },
            "oauth": { "client_id": "c" }, "oauth_resource": "https://docs.example.com",
            "enabled": true,
        }),
        json!({ "transport": "stdio", "command": "npx" }),
        &[
            "url", "bearer_token_env_var", "http_headers", "env_http_headers", "oauth",
            "oauth_resource",
        ],
    )]
    #[tokio::test]
    async fn a_change_of_transport_clears_the_other_arm(
        #[case] before_entry: Value,
        #[case] input: Value,
        #[case] other_arm: &[&str],
    ) {
        let (connection, mut script) = scripted_connection();
        let before = observed(before_entry);
        let binding = user_binding("docs");
        let config: McpServerConfigInput =
            serde_json::from_value(input).expect("the test's input reads");
        let entry =
            compose_codex_mcp_entry(&binding, &config, &before.entry).expect("the input composes");
        let write = McpServerWrite::Upsert { binding, entry };
        let script_run = async {
            let sent = answer_landed_write(&mut script).await;
            let reload = script.next_sent().await;
            script.answer(&reload, &json!({}));
            sent
        };
        let (outcome, sent) = tokio::join!(
            write_codex_mcp_server(&connection, &write, &before, Path::new(HOME)),
            script_run,
        );
        assert_eq!(
            outcome,
            McpServerWriteOutcome::Applied {
                reload_failure: None
            }
        );
        let edits = edits_by_path(&sent);
        for member in other_arm {
            assert_eq!(
                edits.get(&format!("mcp_servers.\"docs\".{member}")),
                Some(&Value::Null),
                "{member} is cleared: {sent}"
            );
        }
    }

    // Killed by a retry, a reload after the conflict, and a version not read again.
    #[tokio::test]
    async fn a_version_conflict_answers_both_versions_and_sends_nothing_more() {
        let (connection, mut script) = scripted_connection();
        let before = observed(json!({ "command": "npx" }));
        let write = McpServerWrite::Remove {
            binding: user_binding("docs"),
        };
        let script_run = async {
            let sent = script.next_sent().await;
            script.send(&refusal(
                &sent,
                -32600,
                "Configuration was modified since last read",
                &json!({ "config_write_error_code": "configVersionConflict" }),
            ));
            let reread = script.next_sent().await;
            assert_eq!(reread["method"], "config/read", "{reread}");
            assert_eq!(reread["params"]["cwd"], HOME, "{reread}");
            script.answer(
                &reread,
                &json!({
                    "config": {}, "origins": {},
                    "layers": [{
                        "name": { "type": "user", "file": format!("{HOME}/.codex/config.toml") },
                        "version": "sha256:new",
                        "config": {},
                    }],
                }),
            );
        };
        let (outcome, ()) = tokio::join!(
            write_codex_mcp_server(&connection, &write, &before, Path::new(HOME)),
            script_run,
        );
        assert_eq!(
            outcome,
            McpServerWriteOutcome::Refused(McpServerWriteRefusal::StaleVersion {
                expected_version: "sha256:old".to_owned(),
                current_version: "sha256:new".to_owned(),
            })
        );
        assert!(
            script.sent.try_recv().is_err(),
            "nothing follows the re-read"
        );
    }

    // Killed by a file fault read as the entry's, the entry's read as the file's, the raw
    // message, and a path taken from the message.
    #[rstest]
    #[case::another_entry("mcp_servers.other.enabled", true)]
    #[case::the_written_entry("mcp_servers.docs.v2.enabled", false)]
    #[tokio::test]
    async fn a_fault_outside_the_entry_is_a_file_fault_with_no_value(
        #[case] faulted_path: &str,
        #[case] is_file_fault: bool,
    ) {
        let (connection, mut script) = scripted_connection();
        let before = observed(json!({ "command": "npx", "enabled": true }));
        let observed_files = before.config_files.clone();
        let write = McpServerWrite::SetEnabled {
            binding: (&user_binding("docs.v2")).into(),
            is_enabled: false,
        };
        let message = format!(
            "Invalid configuration: invalid type: string \"{SECRET}\", expected a boolean in \
             /Users/x/.codex/config.toml in `{faulted_path}`"
        );
        let script_run = async {
            let sent = script.next_sent().await;
            assert_eq!(
                edits_by_path(&sent),
                members(json!({ "mcp_servers.\"docs.v2\".enabled": false }))
            );
            script.send(&refusal(
                &sent,
                -32600,
                &message,
                &json!({ "config_write_error_code": "configValidationError" }),
            ));
        };
        let (outcome, ()) = tokio::join!(
            write_codex_mcp_server(&connection, &write, &before, Path::new(HOME)),
            script_run,
        );
        let (is_refused_as_file_fault, words) =
            if let McpServerWriteOutcome::Refused(McpServerWriteRefusal::ConfigFileInvalid {
                words,
            }) = &outcome
            {
                (true, words)
            } else if let McpServerWriteOutcome::Refused(McpServerWriteRefusal::EntryInvalid {
                words,
            }) = &outcome
            {
                (false, words)
            } else {
                panic!("the fault is refused as the file's or the entry's: {outcome:?}");
            };
        assert_eq!(is_refused_as_file_fault, is_file_fault);
        assert!(!words.contains(SECRET), "{words}");
        assert!(!words.contains("/Users/x"), "{words}");
        assert_eq!(before.config_files, observed_files);
        assert!(script.sent.try_recv().is_err(), "nothing follows a refusal");
    }
}
