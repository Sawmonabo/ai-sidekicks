//! The `hooks` table a Codex conversation's `config` carries: each hook row, and the trust record
//! that lets it run. A start's `config` is the conversation's session-flags layer, so each row is
//! keyed by that layer, its event and its position, and trusted under the hash Codex takes of it,
//! with nothing written to the home's own config. The daemon's own rows call the tools on its
//! hooks entry, one per event it answers.

use serde_json::{Map, Value, json};
use sha2::{Digest as _, Sha256};

use crate::driver::codex::hooks::server::CodexHookEvent;
use crate::driver::codex::service::command_line::CODEX_HOOK_TIMEOUT;
use crate::port::tool_server_route::OpenedToolServerRoute;
use crate::tool_server_name::DAEMON_HOOKS_TOOL_SERVER_NAME;

/// The config key of a conversation's hook rows and their trust records.
pub(crate) const HOOKS_KEY: &str = "hooks";

/// Where in the `hooks` table each row's trust record sits, by the row's key.
const HOOK_STATE_MEMBER: &str = "state";

/// How Codex names the session-flags layer in a hook's key on macOS and Linux.
const SESSION_FLAGS_KEY_SOURCE: &str = "/<session-flags>/config.toml";

/// The members of a tool event every row's template fills, each from the event member of its own
/// name. Codex fails a row whose template names a member the event lacks, so these are only the
/// ones both tool events always carry.
const TOOL_EVENT_MEMBERS: [&str; 7] = [
    "hook_event_name",
    "session_id",
    "turn_id",
    "tool_name",
    "tool_use_id",
    "tool_input",
    "cwd",
];

/// The member only the post-tool event carries.
const TOOL_RESPONSE_MEMBER: &str = "tool_response";

/// One hook row of a conversation: the event it runs on, the tools it matches and its handler as
/// the config writes it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct CodexHookRow {
    /// The event the row runs on.
    pub(crate) event: CodexHookEvent,
    /// The pattern of the tool names it runs on; `None` runs it on every tool.
    pub(crate) matcher: Option<String>,
    /// The row's one handler, `type` among its members.
    pub(crate) handler: Map<String, Value>,
}

/// The daemon's own rows: per event it answers, one `mcp_tool` row calling that event's tool on
/// the hooks entry, its template naming only text placeholders, so the row's hash holds no number
/// but its timeout, which Codex writes as the daemon does.
pub(crate) fn codex_daemon_hook_rows() -> Vec<CodexHookRow> {
    CodexHookEvent::ALL
        .into_iter()
        .map(|event| {
            let mut input: Map<String, Value> = TOOL_EVENT_MEMBERS
                .iter()
                .map(|member| ((*member).to_owned(), Value::from(format!("${{{member}}}"))))
                .collect();
            if event == CodexHookEvent::PostToolUse {
                input.insert(
                    TOOL_RESPONSE_MEMBER.to_owned(),
                    Value::from(format!("${{{TOOL_RESPONSE_MEMBER}}}")),
                );
            }
            let handler = Map::from_iter([
                ("type".to_owned(), Value::from("mcp_tool")),
                (
                    "server".to_owned(),
                    Value::from(DAEMON_HOOKS_TOOL_SERVER_NAME),
                ),
                ("tool".to_owned(), Value::from(event.hook_tool().name)),
                ("input".to_owned(), Value::Object(input)),
                // Longer than any hold, since a hook that times out lets its call through.
                (
                    "timeout".to_owned(),
                    Value::from(CODEX_HOOK_TIMEOUT.as_secs()),
                ),
            ]);
            CodexHookRow {
                event,
                matcher: None,
                handler,
            }
        })
        .collect()
}

/// Whether a spawn whose daemon entries `route` opened sends the daemon's rows: only beside its
/// hooks entry, which their calls reach.
pub(crate) fn sends_codex_daemon_hook_rows(route: Option<&OpenedToolServerRoute>) -> bool {
    route.is_some_and(|route| route.entry(DAEMON_HOOKS_TOOL_SERVER_NAME).is_some())
}

/// The `hooks` table for `rows`: each row in a group of its own under its event, in order, and
/// under `state` each row's trust record by its key.
pub(crate) fn compose_codex_hooks_config(rows: &[CodexHookRow]) -> Value {
    let mut table = Map::new();
    let mut state = Map::new();
    for (row, key) in rows.iter().zip(codex_hook_row_keys(rows)) {
        table
            .entry(row.event.config_name())
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .expect("an event's groups are only ever a list")
            .push(compose_group(row));
        state.insert(key, json!({ "trusted_hash": codex_hook_row_hash(row) }));
    }
    table.insert(HOOK_STATE_MEMBER.to_owned(), Value::Object(state));
    Value::Object(table)
}

/// Each of `rows`' keys as Codex keys a row of the session-flags layer, in order: the layer, the
/// event's label, the row's group among its event's and its handler, the group's only one.
pub(crate) fn codex_hook_row_keys(rows: &[CodexHookRow]) -> Vec<String> {
    rows.iter()
        .enumerate()
        .map(|(position, row)| {
            let group = rows[..position]
                .iter()
                .filter(|earlier| earlier.event == row.event)
                .count();
            format!(
                "{SESSION_FLAGS_KEY_SOURCE}:{}:{group}:0",
                row.event.key_label()
            )
        })
        .collect()
}

// The row's group as the config writes it: its matcher, where set, and its one handler.
fn compose_group(row: &CodexHookRow) -> Value {
    let mut group = json!({ "hooks": [row.handler] });
    if let Some(matcher) = &row.matcher {
        group["matcher"] = Value::from(matcher.as_str());
    }
    group
}

// The hash Codex trusts `row` under: `sha256:` and the hex SHA-256 of the compact JSON of its
// event's label beside its group, every object's members sorted.
fn codex_hook_row_hash(row: &CodexHookRow) -> String {
    let mut identity = compose_group(row);
    identity["event_name"] = Value::from(row.event.key_label());
    identity.sort_all_objects();
    let canonical = serde_json::to_vec(&identity).expect("a JSON value always serializes");
    format!(
        "sha256:{}",
        base16ct::lower::encode_string(&Sha256::digest(canonical))
    )
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::{
        CodexHookRow, codex_daemon_hook_rows, codex_hook_row_hash, codex_hook_row_keys,
        compose_codex_hooks_config,
    };
    use crate::driver::codex::hooks::server::CodexHookEvent;

    // A `hooks/list` reply of Codex 0.166.0 for a conversation started with the daemon's rows,
    // its members as the release's `HookMetadata` writes them.
    fn listed_reply() -> Value {
        json!({ "data": [{
            "cwd": "/work/app",
            "hooks": [
                {
                    "key": "/<session-flags>/config.toml:pre_tool_use:0:0",
                    "eventName": "preToolUse",
                    "handlerType": "mcpTool",
                    "server": "sidekicks_hooks",
                    "tool": "pre_tool_use",
                    "source": "sessionFlags",
                    "trustStatus": "trusted",
                },
                {
                    "key": "/<session-flags>/config.toml:post_tool_use:0:0",
                    "eventName": "postToolUse",
                    "handlerType": "mcpTool",
                    "server": "sidekicks_hooks",
                    "tool": "post_tool_use",
                    "source": "sessionFlags",
                    "trustStatus": "trusted",
                },
            ],
            "warnings": [],
            "errors": [],
        }]})
    }

    // Every row is trusted under the key `hooks/list` answers for it, and a row is hashed as
    // Codex hashes it: its own recorded trust hashes for a plugin's command rows are matched.
    // Killed by the event's config name (`PreToolUse`) in the key, by a key off its group, and by
    // a hash over unsorted members or another form than Codex's compact JSON.
    #[test]
    fn each_row_is_trusted_under_the_key_and_hash_codex_gives_it() {
        let rows = codex_daemon_hook_rows();
        let config = compose_codex_hooks_config(&rows);

        let written: Vec<&str> = config["state"]
            .as_object()
            .expect("the table holds trust records")
            .keys()
            .map(String::as_str)
            .collect();
        let reply = listed_reply();
        let listed: Vec<&str> = reply["data"][0]["hooks"]
            .as_array()
            .expect("the reply lists hooks")
            .iter()
            .map(|hook| hook["key"].as_str().expect("a listed hook has a key"))
            .collect();
        assert_eq!(written, listed);
        assert_eq!(codex_hook_row_keys(&rows), listed);
        for row in &rows {
            assert_eq!(
                config[row.event.config_name()][0]["hooks"][0],
                Value::Object(row.handler.clone())
            );
        }

        // Codex's own plugin-hook test trusts this group of each event under these hashes.
        let Value::Object(handler) = json!({
            "type": "command",
            "command": "python3 -I -S ${PLUGIN_ROOT}/hooks/pre_tool_use_hook.py",
            "timeout": 600,
            "async": false,
        }) else {
            unreachable!("a JSON object literal is an object");
        };
        let hash_of = |event| {
            codex_hook_row_hash(&CodexHookRow {
                event,
                matcher: Some("^Bash$".to_owned()),
                handler: handler.clone(),
            })
        };
        assert_eq!(
            hash_of(CodexHookEvent::PreToolUse),
            "sha256:c9ee1aca1b5d8c72b99df6571c87d61350b09f7f4594ae30e7250a2027e9d76b"
        );
        assert_eq!(
            hash_of(CodexHookEvent::PostToolUse),
            "sha256:9eef43ad6f26b1f9b94f318a50445f8bb62c363da08152a2966b73d308bf42ba"
        );
        assert_eq!(
            config["state"][listed[0]]["trusted_hash"],
            Value::from(codex_hook_row_hash(&rows[0]))
        );
    }
}
