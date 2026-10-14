//! The command line a Codex service on an account home the app manages starts with: the listener
//! and the `-c` switches every conversation on it shares. Each `-c` value is TOML, whose integers
//! are 64-bit, so the largest holds below exceed what a JSON number keeps.

use std::time::Duration;

use futures::future::BoxFuture;
use serde::Serialize;

/// The hook `timeout`: the largest 64-bit integer divided by 1000 in seconds, so the same hold
/// also fits the code-mode yield in milliseconds. It lies past any wall-clock instant, so a caller
/// adds it with `checked_add`, where a failure means no deadline.
pub(crate) const CODEX_HOOK_TIMEOUT: Duration =
    Duration::from_secs(i64::MAX.cast_unsigned() / 1000);

/// How long a conversation no client holds stays loaded, so a moved one is free to resume soon.
const CODEX_THREAD_UNLOAD_DELAY: Duration = Duration::from_secs(5);

/// The daemon's two hook programs, as the command lines Codex runs for each tool call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexHookCommands {
    /// Runs before each tool call; it holds a paused helper and answers the deadline's denial.
    pub(crate) pre_tool_use: String,
    /// Runs after each tool call.
    pub(crate) post_tool_use: String,
}

/// The daemon's hooks a managed service starts with, and the socket their programs reach.
pub(crate) trait CodexDaemonHooks: Send + Sync {
    /// The hook programs' command lines.
    fn commands(&self) -> &CodexHookCommands;

    /// Starts listening for the hook programs, once; awaited before a service that runs them. It
    /// fails when the socket cannot be opened.
    fn listen(&self) -> BoxFuture<'_, std::io::Result<()>>;
}

/// What one service start carries beyond the switches every managed service shares.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexServiceCommandLineInput {
    /// `unix://` for the home's own control socket, or `unix://<path>` for a second service that
    /// starts beside the first on one home.
    pub(crate) listen_address: String,
    /// The daemon's hook programs, inline; `None` starts the service with no daemon hooks.
    pub(crate) hook_commands: Option<CodexHookCommands>,
    /// More `key=value` switches another part of the daemon adds, such as the telemetry export.
    pub(crate) additional_config_overrides: Vec<String>,
}

/// One matcher group of a hook event, as Codex's `hooks` table reads it.
#[derive(Serialize)]
struct CodexHookMatcher<'command> {
    matcher: &'static str,
    hooks: [CodexCommandHook<'command>; 1],
}

/// One command hook.
#[derive(Serialize)]
struct CodexCommandHook<'command> {
    #[serde(rename = "type")]
    hook_type: &'static str,
    command: &'command str,
    timeout: i64,
}

/// The arguments after the Codex command for one managed service.
pub(crate) fn compose_codex_service_arguments(input: &CodexServiceCommandLineInput) -> Vec<String> {
    let hook_overrides = input.hook_commands.iter().flat_map(|commands| {
        [
            compose_hook_override("PreToolUse", &commands.pre_tool_use),
            compose_hook_override("PostToolUse", &commands.post_tool_use),
        ]
    });
    let shared_overrides = [
        format!(
            "features.code_mode.default_exec_yield_time_ms={}",
            CODEX_HOOK_TIMEOUT.as_millis()
        ),
        "features.browser_use=false".to_owned(),
        format!(
            "thread_unload_delay_secs={}",
            CODEX_THREAD_UNLOAD_DELAY.as_secs()
        ),
        // The session's compaction bound is a share of the whole window, so the limit counts the
        // whole context, Codex's own default, even where a config file chose only what follows
        // the prefix.
        "model_auto_compact_token_limit_scope=\"total\"".to_owned(),
    ];
    let overrides = hook_overrides
        .chain(shared_overrides)
        .chain(input.additional_config_overrides.iter().cloned());
    [
        "app-server".to_owned(),
        "--listen".to_owned(),
        input.listen_address.clone(),
    ]
    .into_iter()
    .chain(overrides.flat_map(|config_override| ["-c".to_owned(), config_override]))
    .collect()
}

/// One hook event's switch, its value written by TOML's own writer so any command text, quotes,
/// reverse solidi and control characters included, reads back unchanged.
fn compose_hook_override(event_name: &str, command: &str) -> String {
    let hook = [CodexHookMatcher {
        matcher: "*",
        hooks: [CodexCommandHook {
            hook_type: "command",
            command,
            timeout: i64::try_from(CODEX_HOOK_TIMEOUT.as_secs())
                .expect("the hook timeout is a 64-bit integer divided by 1000"),
        }],
    }];
    let mut value = String::new();
    hook.serialize(toml::ser::ValueSerializer::new(&mut value))
        .expect("a hook's strings and integer are TOML values");
    format!("hooks.{event_name}={value}")
}

#[cfg(test)]
mod tests {
    use super::{CodexHookCommands, CodexServiceCommandLineInput, compose_codex_service_arguments};

    #[test]
    fn the_hook_override_reads_back_its_command_and_timeout_unchanged() {
        let command = "/opt/hooks/run \"quoted\" C:\\hooks\\run.exe \u{7f}end";
        let arguments = compose_codex_service_arguments(&CodexServiceCommandLineInput {
            listen_address: "unix://".to_owned(),
            hook_commands: Some(CodexHookCommands {
                pre_tool_use: command.to_owned(),
                post_tool_use: "/opt/hooks/after".to_owned(),
            }),
            additional_config_overrides: Vec::new(),
        });
        let pre_tool_use = arguments
            .iter()
            .find(|argument| argument.starts_with("hooks.PreToolUse="))
            .unwrap();

        let config: toml::Table = toml::from_str(pre_tool_use).unwrap();
        let hook = &config["hooks"]["PreToolUse"][0]["hooks"][0];

        assert_eq!(hook["command"].as_str(), Some(command));
        assert_eq!(hook["timeout"].as_integer(), Some(9_223_372_036_854_775));
        assert!(arguments.contains(
            &"features.code_mode.default_exec_yield_time_ms=9223372036854775000".to_owned()
        ));
    }
}
