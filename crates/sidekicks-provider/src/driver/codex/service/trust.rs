//! Trust for the daemon's two command hooks on the terminal service the daemon starts on the
//! person's own Codex folder, the read of the hooks a running service's command line set, and the
//! check that a conversation lists the hook rows its config sent as trusted. Codex runs a hook only
//! once its hash is recorded as trusted and skips an untrusted one without a word, so the daemon
//! lists the hooks, records the hash of each of its own that is not yet trusted, and lists again
//! to confirm before any conversation; a conversation's rows carry their trust in its config, so
//! they are only listed before its first turn.

use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::driver::codex::app_server_protocol::{
    ConfigValueWriteParams, HooksListParams, MergeStrategy,
};
use crate::driver::codex::service::command_line::{CodexHookCommands, CodexListedHook};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::thread::settings::hook_rows::{
    codex_daemon_hook_rows, codex_hook_row_keys,
};
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::inbound_json::decode_inbound_json;

/// The request that lists the hooks a service runs, with each one's key, hash and trust.
const HOOKS_LIST_METHOD: &str = "hooks/list";

/// The request that writes one value into the person's Codex config.
const CONFIG_VALUE_WRITE_METHOD: &str = "config/value/write";

/// Where Codex keeps each hook's trusted hash, by the hook's key.
const HOOK_STATE_KEY_PATH: &str = "hooks.state";

/// The source `hooks/list` names for a hook the service's command line set.
const SESSION_FLAGS_HOOK_SOURCE: &str = "sessionFlags";

// The members of a `hooks/list` reply the trust reads.
#[derive(Deserialize)]
struct HooksListReply {
    #[serde(default)]
    data: Vec<HooksListEntry>,
}

#[derive(Deserialize)]
struct HooksListEntry {
    #[serde(default)]
    hooks: Vec<ListedHook>,
    #[serde(default)]
    warnings: Vec<String>,
    #[serde(default)]
    errors: Vec<HookLoadError>,
}

#[derive(Deserialize)]
struct HookLoadError {
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListedHook {
    source: Option<String>,
    event_name: Option<String>,
    command: Option<String>,
    timeout_sec: Option<u64>,
    key: Option<String>,
    current_hash: Option<String>,
    trust_status: Option<String>,
}

// One of the daemon's hooks as the service lists it.
struct DaemonHook<'reply> {
    key: &'reply str,
    current_hash: &'reply str,
    is_trusted: bool,
}

/// Records the trusted hash of each of the daemon's `hook_commands` the terminal service lists
/// untrusted, in one upsert, then lists the hooks again. Fails with `CodexError::Transport` when
/// the service does not list a daemon hook with its key and hash, its reply cannot be read, or a
/// daemon hook is still untrusted after the write, since an untrusted hook never runs; a failed
/// request fails as the connection reports it.
pub(crate) async fn trust_codex_daemon_hooks(
    connection: &CodexAppServerConnection,
    hook_commands: &CodexHookCommands,
) -> Result<(), CodexError> {
    let reply = list_hooks(connection, None).await?;
    // Each untrusted hook's key, naming its trusted hash, merged into what the config holds.
    let untrusted: Map<String, Value> = read_daemon_hooks(&reply, hook_commands)?
        .into_iter()
        .filter(|hook| !hook.is_trusted)
        .map(|hook| {
            (
                hook.key.to_owned(),
                json!({ "trusted_hash": hook.current_hash }),
            )
        })
        .collect();
    if untrusted.is_empty() {
        return Ok(());
    }
    connection
        .request(
            CONFIG_VALUE_WRITE_METHOD,
            &ConfigValueWriteParams {
                key_path: HOOK_STATE_KEY_PATH.to_owned(),
                value: Value::Object(untrusted),
                merge_strategy: MergeStrategy::Upsert,
                file_path: None,
                expected_version: None,
            },
        )
        .await?;
    let relisted = list_hooks(connection, None).await?;
    if read_daemon_hooks(&relisted, hook_commands)?
        .iter()
        .any(|hook| !hook.is_trusted)
    {
        return Err(CodexError::Transport {
            detail: "The Codex service still lists a daemon hook as untrusted after its hash was \
                     recorded, so the hook would never run."
                .to_owned(),
            cause: None,
        });
    }
    Ok(())
}

/// Every hook the service's command line set, with its event as the daemon's hooks name it
/// (`PreToolUse`), for the comparison with the hooks this daemon would start the service with; a
/// member the reply leaves out reads empty, so the hook still counts. Fails as the connection's
/// request does, and with `CodexError::Transport` for an unreadable reply.
pub(crate) async fn list_codex_hooks(
    connection: &CodexAppServerConnection,
) -> Result<Vec<CodexListedHook>, CodexError> {
    let reply = list_hooks(connection, None).await?;
    Ok(reply
        .data
        .into_iter()
        .flat_map(|entry| entry.hooks)
        .filter(|hook| hook.source.as_deref() == Some(SESSION_FLAGS_HOOK_SOURCE))
        .map(|hook| CodexListedHook {
            event_name: hook_event_name(&hook.event_name.unwrap_or_default()),
            command: hook.command.unwrap_or_default(),
            timeout_seconds: hook.timeout_sec.unwrap_or_default(),
        })
        .collect())
}

// The event as a hook's config names it: `hooks/list` writes `preToolUse`, the config
// `PreToolUse`.
fn hook_event_name(listed: &str) -> String {
    let mut characters = listed.chars();
    characters.next().map_or_else(String::new, |first| {
        first.to_uppercase().chain(characters).collect()
    })
}

/// Confirms the conversation `thread_id` lists each of the daemon's hook rows its config sent,
/// from its session flags and trusted, before its first turn: Codex skips an unlisted or untrusted
/// row without a word, so its hook would never run. Fails with `CodexError::Transport` naming the
/// row and carrying Codex's own warnings and load errors, and as the connection's request does.
pub(crate) async fn confirm_codex_daemon_hook_rows(
    connection: &CodexAppServerConnection,
    thread_id: &str,
) -> Result<(), CodexError> {
    let reply = list_hooks(connection, Some(thread_id)).await?;
    let listed = reply.data.iter().flat_map(|entry| &entry.hooks);
    for key in codex_hook_row_keys(&codex_daemon_hook_rows()) {
        let status = listed
            .clone()
            .find(|hook| {
                hook.source.as_deref() == Some(SESSION_FLAGS_HOOK_SOURCE)
                    && hook.key.as_deref() == Some(key.as_str())
            })
            .map(|hook| hook.trust_status.as_deref().unwrap_or_default());
        if matches!(status, Some("trusted" | "managed")) {
            continue;
        }
        let provider_words: Vec<&str> = reply
            .data
            .iter()
            .flat_map(|entry| {
                entry
                    .warnings
                    .iter()
                    .map(String::as_str)
                    .chain(entry.errors.iter().map(|error| error.message.as_str()))
            })
            .collect();
        let state = status.map_or_else(
            || "does not list it".to_owned(),
            |status| format!("lists it as \"{status}\""),
        );
        return Err(CodexError::Transport {
            detail: format!(
                "Codex {state} for the hook row \"{key}\" its conversation was started with, so \
                 the hook would never run. Codex says: {}",
                if provider_words.is_empty() {
                    "nothing more".to_owned()
                } else {
                    provider_words.join("; ")
                }
            ),
            cause: None,
        });
    }
    Ok(())
}

// The service's `hooks/list` reply, for the conversation `thread_id` when named, read for the
// members trust needs.
async fn list_hooks(
    connection: &CodexAppServerConnection,
    thread_id: Option<&str>,
) -> Result<HooksListReply, CodexError> {
    let reply = connection
        .request(
            HOOKS_LIST_METHOD,
            &HooksListParams {
                cwds: Vec::new(),
                thread_id: thread_id.map(str::to_owned),
            },
        )
        .await?;
    serde_json::from_str(&decode_inbound_json(reply.get().as_bytes())).map_err(|error| {
        CodexError::Transport {
            detail: format!("The Codex service's \"{HOOKS_LIST_METHOD}\" reply is unreadable"),
            cause: Some(Box::new(error)),
        }
    })
}

// The daemon's two hooks in `reply`, the pre-tool one first; fails when either is not listed as
// a command-line hook with its key and hash.
fn read_daemon_hooks<'reply>(
    reply: &'reply HooksListReply,
    hook_commands: &CodexHookCommands,
) -> Result<[DaemonHook<'reply>; 2], CodexError> {
    let find = |command: &str| {
        reply
            .data
            .iter()
            .flat_map(|entry| &entry.hooks)
            .find_map(|hook| read_daemon_hook(hook, command))
            .ok_or_else(|| CodexError::Transport {
                detail: "The Codex service does not list a hook the daemon started it with, so it \
                         cannot be trusted and would never run."
                    .to_owned(),
                cause: None,
            })
    };
    Ok([
        find(&hook_commands.pre_tool_use)?,
        find(&hook_commands.post_tool_use)?,
    ])
}

// `hook` read as the daemon's hook running `command`, when it is one with a key and a hash. Codex
// runs a `managed` hook as it runs a trusted one, so both count, though a hook from the session's
// flags, the only source read here, is never managed.
fn read_daemon_hook<'reply>(hook: &'reply ListedHook, command: &str) -> Option<DaemonHook<'reply>> {
    if hook.source.as_deref() != Some(SESSION_FLAGS_HOOK_SOURCE)
        || hook.command.as_deref() != Some(command)
    {
        return None;
    }
    let key = hook.key.as_deref().filter(|key| !key.is_empty())?;
    let current_hash = hook
        .current_hash
        .as_deref()
        .filter(|current_hash| !current_hash.is_empty())?;
    Some(DaemonHook {
        key,
        current_hash,
        is_trusted: matches!(hook.trust_status.as_deref(), Some("trusted" | "managed")),
    })
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use rstest::rstest;
    use serde_json::{Value, json};

    use super::confirm_codex_daemon_hook_rows;
    use crate::driver::codex::session::errors::CodexError;
    use crate::driver::codex::transport::connection::scripted_service::scripted_connection;

    /// The conversation the check lists the hooks of.
    const THREAD_ID: &str = "thread-1";

    // The listed hook of the daemon's row on `event`, from the session flags under `trust`.
    fn listed_row(event: &str, trust: &str) -> Value {
        json!({
            "key": format!("/<session-flags>/config.toml:{event}:0:0"),
            "handlerType": "mcpTool",
            "source": "sessionFlags",
            "trustStatus": trust,
        })
    }

    // A conversation starts only when it lists every row its config sent as trusted, and a start
    // that fails says which row and carries Codex's own words. Killed by the check skipped, by a
    // listing of the service's hooks in place of the conversation's, and by an untrusted row
    // counted as listed.
    #[rstest]
    #[case::every_row_trusted(
        vec![listed_row("pre_tool_use", "trusted"), listed_row("post_tool_use", "trusted")],
        None
    )]
    #[case::a_row_missing(
        vec![listed_row("pre_tool_use", "trusted")],
        Some("does not list it for the hook row \"/<session-flags>/config.toml:post_tool_use:0:0\"")
    )]
    #[case::a_row_untrusted(
        vec![listed_row("pre_tool_use", "untrusted"), listed_row("post_tool_use", "trusted")],
        Some("lists it as \"untrusted\" for the hook row \"/<session-flags>/config.toml:pre_tool")
    )]
    #[tokio::test]
    async fn a_conversation_starts_only_with_every_sent_hook_row_listed_and_trusted(
        #[case] hooks: Vec<Value>,
        #[case] refusal: Option<&str>,
    ) {
        let (connection, mut script, _frames) = scripted_connection();
        let answering = async {
            let request = script.next_sent().await;
            assert_eq!(request["method"], "hooks/list");
            assert_eq!(request["params"]["threadId"], THREAD_ID);
            script.answer(
                &request,
                &json!({ "data": [{
                    "cwd": "/work/app",
                    "hooks": hooks,
                    "warnings": ["a hook file is unreadable"],
                    "errors": [{ "path": "/work/app/.codex/hooks.json", "message": "bad matcher" }],
                }]}),
            );
        };
        let (confirmed, ()) = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::join!(
                confirm_codex_daemon_hook_rows(&connection, THREAD_ID),
                answering
            )
        })
        .await
        .expect("the check settles");
        match (confirmed, refusal) {
            (Ok(()), None) => {}
            (Err(CodexError::Transport { detail, .. }), Some(refusal)) => {
                assert!(detail.contains(refusal), "{detail}");
                assert!(
                    detail.contains("a hook file is unreadable; bad matcher"),
                    "{detail}"
                );
            }
            (confirmed, refusal) => panic!("checked {confirmed:?}, expected {refusal:?}"),
        }
    }
}
