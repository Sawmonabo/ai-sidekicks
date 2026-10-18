//! The command line a Codex service on an account home the app manages starts with: the listener
//! and the `-c` switches every conversation on it shares, and the daemon's hook programs those
//! switches name. Each `-c` value is TOML, whose integers are 64-bit, so the largest holds below
//! exceed what a JSON number keeps.

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures::future::BoxFuture;
use serde::Serialize;
use sidekicks_platforms::{PathRules, ShellWordRefused};

/// The hook `timeout`: the largest 64-bit integer divided by 1000 in seconds, so the same hold
/// also fits the code-mode yield in milliseconds. It lies past any wall-clock instant, so a caller
/// adds it with `checked_add`, where a failure means no deadline.
pub(crate) const CODEX_HOOK_TIMEOUT: Duration =
    Duration::from_secs(i64::MAX.cast_unsigned() / 1000);

/// How long a conversation no client holds stays loaded, so a moved one is free to resume soon.
const CODEX_THREAD_UNLOAD_DELAY: Duration = Duration::from_secs(5);

/// The hook event before each tool call.
const PRE_TOOL_USE_EVENT: &str = "PreToolUse";

/// The hook event after each tool call.
const POST_TOOL_USE_EVENT: &str = "PostToolUse";

/// What a program path ends with on Linux once the running program's file is replaced.
const REPLACED_PROGRAM_SUFFIX: &str = " (deleted)";

/// The daemon's two hook programs, as the command lines Codex runs for each tool call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexHookCommands {
    /// Runs before each tool call; it holds a paused helper and answers the deadline's denial.
    pub(crate) pre_tool_use: String,
    /// Runs after each tool call.
    pub(crate) post_tool_use: String,
}

impl CodexHookCommands {
    // Each event's name and its command line.
    fn events(&self) -> [(&'static str, &str); 2] {
        [
            (PRE_TOOL_USE_EVENT, &self.pre_tool_use),
            (POST_TOOL_USE_EVENT, &self.post_tool_use),
        ]
    }
}

/// One hook a running service lists in its `hooks/list` reply, the members the daemon compares.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexListedHook {
    /// The hook's event (`PreToolUse`).
    pub(crate) event_name: String,
    /// The command line the service runs: on Windows the `commandWindows` line, where one is set.
    pub(crate) command: String,
    /// The hook's timeout, in seconds; `None` where it names none.
    pub(crate) timeout_seconds: Option<u64>,
}

/// What a daemon does with a lasting service it finds running.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LastingServiceVerdict {
    /// Its hooks run this daemon's program as it would start them, so the daemon joins it.
    Adopt,
    /// Its hooks run another program, or one no longer on disk, so it is replaced.
    Restart,
}

/// Why the daemon's hook commands could not be written.
#[derive(Debug, thiserror::Error)]
pub(crate) enum HookCommandError {
    /// The daemon's program path is not UTF-8 text, which a command line carries.
    #[error("the daemon's program path is not UTF-8 text: {}", .0.display())]
    ProgramPathNotText(PathBuf),
    /// A word cannot be written for the system's command shell.
    #[error("a hook command word cannot be written for the system's command shell")]
    Word(#[from] ShellWordRefused),
}

/// The hook commands that run `daemon_program`, the daemon's own program as it started, in its
/// hidden `hook provider` mode for each tool event: the quoted program and its arguments alone,
/// which Codex runs through `sh -c` or, on Windows, `%COMSPEC% /C` in the folder it sets. Fails
/// when the path is not UTF-8 text or a word cannot be written for the system's command shell.
pub(crate) fn compose_daemon_hook_commands(
    daemon_program: &Path,
) -> Result<CodexHookCommands, HookCommandError> {
    let program = daemon_program
        .to_str()
        .ok_or_else(|| HookCommandError::ProgramPathNotText(daemon_program.to_owned()))?;
    Ok(CodexHookCommands {
        pre_tool_use: compose_daemon_hook_command(program, PRE_TOOL_USE_EVENT)?,
        post_tool_use: compose_daemon_hook_command(program, POST_TOOL_USE_EVENT)?,
    })
}

/// Whether the lasting service a daemon finds running can be joined: each of the daemon's events
/// has a hook in `listed`, the service's `hooks/list` reply, whose command and timeout are the
/// ones `composed` from `daemon_program` gives, and `daemon_program` is still on disk under its
/// path; any difference answers [`LastingServiceVerdict::Restart`], which the daemon's start hands
/// to the planned restart. Never reproduces Codex's own hook hash. Fails when the program's
/// presence cannot be read.
pub(crate) fn compare_daemon_hook_commands(
    listed: &[CodexListedHook],
    composed: &CodexHookCommands,
    daemon_program: &Path,
) -> io::Result<LastingServiceVerdict> {
    let is_program_replaced = daemon_program
        .as_os_str()
        .as_encoded_bytes()
        .ends_with(REPLACED_PROGRAM_SUFFIX.as_bytes());
    if is_program_replaced || !daemon_program.try_exists()? {
        return Ok(LastingServiceVerdict::Restart);
    }
    let timeout_seconds = CODEX_HOOK_TIMEOUT.as_secs();
    let is_every_event_listed = composed.events().iter().all(|(event_name, command)| {
        listed.iter().any(|hook| {
            hook.event_name == *event_name
                && hook.command == *command
                && hook.timeout_seconds == Some(timeout_seconds)
        })
    });
    Ok(if is_every_event_listed {
        LastingServiceVerdict::Adopt
    } else {
        LastingServiceVerdict::Restart
    })
}

// One event's command, every word quoted for the system's command shell. One command per event,
// so Codex lists and trusts each, and the program knows its event even when its input is unread.
fn compose_daemon_hook_command(
    program: &str,
    event_name: &str,
) -> Result<String, ShellWordRefused> {
    let words = [program, "hook", "provider", "--event", event_name]
        .into_iter()
        .map(|word| PathRules::NATIVE.quote_shell_word(word))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(words.join(" "))
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

/// One command hook; on Windows its line is also Codex's `commandWindows`, the line it runs there.
#[derive(Serialize)]
struct CodexCommandHook<'command> {
    #[serde(rename = "type")]
    hook_type: &'static str,
    command: &'command str,
    #[serde(rename = "commandWindows", skip_serializing_if = "Option::is_none")]
    command_windows: Option<&'command str>,
    timeout: i64,
}

/// The arguments after the Codex command for one managed service.
pub(crate) fn compose_codex_service_arguments(input: &CodexServiceCommandLineInput) -> Vec<String> {
    let hook_overrides = input.hook_commands.iter().flat_map(|commands| {
        commands
            .events()
            .map(|(event_name, command)| compose_hook_override(event_name, command))
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
            command_windows: (PathRules::NATIVE == PathRules::Windows).then_some(command),
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
    use rstest::rstest;

    use super::{
        CODEX_HOOK_TIMEOUT, CodexHookCommands, CodexListedHook, CodexServiceCommandLineInput,
        LastingServiceVerdict, compare_daemon_hook_commands, compose_codex_service_arguments,
        compose_daemon_hook_commands,
    };

    // Mutations killed: answering adopt without reading the list, or comparing the event alone.
    #[rstest]
    #[case::the_same_hooks("", Some(CODEX_HOOK_TIMEOUT.as_secs()), LastingServiceVerdict::Adopt)]
    #[case::another_program(
        "-old",
        Some(CODEX_HOOK_TIMEOUT.as_secs()),
        LastingServiceVerdict::Restart
    )]
    #[case::another_timeout("", Some(600), LastingServiceVerdict::Restart)]
    fn compare_daemon_hook_commands_adopts_only_the_same_hooks(
        #[case] listed_program_suffix: &str,
        #[case] timeout_seconds: Option<u64>,
        #[case] expected: LastingServiceVerdict,
    ) {
        let folder = tempfile::tempdir().expect("a scratch folder is made");
        let program = folder.path().join("sidekicks-daemon");
        std::fs::write(&program, b"").expect("the program file is written");
        let composed = compose_daemon_hook_commands(&program).expect("the path is text");
        let listed_program = folder
            .path()
            .join(format!("sidekicks-daemon{listed_program_suffix}"));
        let listed: Vec<CodexListedHook> = compose_daemon_hook_commands(&listed_program)
            .expect("the path is text")
            .events()
            .iter()
            .map(|(event_name, command)| CodexListedHook {
                event_name: (*event_name).to_owned(),
                command: (*command).to_owned(),
                timeout_seconds,
            })
            .collect();

        let verdict = compare_daemon_hook_commands(&listed, &composed, &program)
            .expect("the program's presence reads");

        assert_eq!(verdict, expected);
    }

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
