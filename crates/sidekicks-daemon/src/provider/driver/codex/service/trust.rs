//! Trust for the daemon's two command hooks on the terminal service the daemon starts on the
//! person's own Codex folder. Codex runs a command hook only once its hash is recorded as trusted
//! and skips an untrusted one without a word, so the daemon lists the hooks, records the hash of
//! each of its own that is not yet trusted, and lists again to confirm before any conversation.

use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::provider::driver::codex::app_server_protocol::{
    ConfigValueWriteParams, HooksListParams, MergeStrategy,
};
use crate::provider::driver::codex::service::command_line::{CodexHookCommands, CodexListedHook};
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::transport::connection::CodexAppServerConnection;
use crate::provider::inbound_json::decode_inbound_json;

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
    let reply = list_hooks(connection).await?;
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
    let relisted = list_hooks(connection).await?;
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

/// Every command hook the service lists, with its event as the daemon's hooks name it
/// (`PreToolUse`), for the comparison with the hooks this daemon would start the service with.
/// Fails as the connection's request does, and with `CodexError::Transport` for an unreadable
/// reply.
pub(crate) async fn list_codex_hooks(
    connection: &CodexAppServerConnection,
) -> Result<Vec<CodexListedHook>, CodexError> {
    let reply = list_hooks(connection).await?;
    Ok(reply
        .data
        .into_iter()
        .flat_map(|entry| entry.hooks)
        .filter_map(|hook| {
            Some(CodexListedHook {
                event_name: hook_event_name(&hook.event_name?),
                command: hook.command?,
                timeout_seconds: hook.timeout_sec?,
            })
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

// The service's `hooks/list` reply, read for the members trust needs.
async fn list_hooks(connection: &CodexAppServerConnection) -> Result<HooksListReply, CodexError> {
    let reply = connection
        .request(HOOKS_LIST_METHOD, &HooksListParams { cwds: Vec::new() })
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
