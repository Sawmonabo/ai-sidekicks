//! The command line a Codex service the daemon starts runs: the listener and the `-c` switches
//! every conversation on it shares; and the two command hooks the terminal service on the person's
//! own Codex folder runs while the daemon's program dispatches its hook mode, which run that
//! program. Each `-c` value is TOML, whose
//! integers are 64-bit, so the holds below exceed what a JSON number keeps exactly.

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use sidekicks_platforms::{
    PathRules, RunningProgramPath, ShellWordRefused, read_running_program_path,
};

use crate::driver::codex::service::home::CodexServiceKind;

/// The hook `timeout`, 10^12 seconds, a hold no call outlasts and one Codex runs without fault;
/// the code-mode yield takes the same hold in milliseconds, 10^15.
pub(crate) const CODEX_HOOK_TIMEOUT: Duration = Duration::from_secs(1_000_000_000_000);

/// How long a conversation no client holds stays loaded, so a moved one is free to resume soon.
const CODEX_THREAD_UNLOAD_DELAY: Duration = Duration::from_secs(5);

/// The hook event before each tool call.
const PRE_TOOL_USE_EVENT: &str = "PreToolUse";

/// The hook event after each tool call.
const POST_TOOL_USE_EVENT: &str = "PostToolUse";

/// The terminal service's two command hooks, as the command lines Codex runs for each tool call;
/// each runs the daemon's program, which asks the daemon for the answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexHookCommands {
    /// Runs before each tool call; the daemon may hold or deny the call.
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

    /// The `-c` switches, one per event, that the terminal service starts with beside the ones
    /// [`compose_codex_service_arguments`] composes.
    pub(crate) fn config_overrides(&self) -> [String; 2] {
        self.events()
            .map(|(event_name, command)| compose_hook_override(event_name, command))
    }
}

/// The hooks the daemon starts the terminal service with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum TerminalServiceHooks {
    /// None, while the daemon's program dispatches no hook mode.
    NoHooks,
    /// The daemon's two command hooks, running its program as it started.
    Daemon(CodexHookCommands),
    /// The daemon's program was replaced on disk, so no hook of the daemon's can run it.
    ProgramReplaced,
}

/// One hook a running service's command line set, as its `hooks/list` reply lists it: the members
/// the daemon compares.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexListedHook {
    /// The hook's event (`PreToolUse`).
    pub(crate) event_name: String,
    /// The command line the service runs.
    pub(crate) command: String,
    /// The hook's timeout, in seconds.
    pub(crate) timeout_seconds: u64,
}

/// What a daemon does with a lasting service it finds running.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LastingServiceVerdict {
    /// Its command line set the hooks this daemon would start it with, so the daemon joins it.
    Adopt,
    /// Its hooks differ from those, or run a program no longer on disk, so it is replaced.
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
    /// The system could not name the daemon's own program.
    #[error("the daemon's own program could not be read")]
    ProgramUnread(#[source] io::Error),
}

/// The terminal service's hook commands that run `daemon_program`, the daemon's own program as it
/// started, in its hidden `hook provider` mode for each tool event: the quoted program and its
/// arguments alone, which Codex runs through `$SHELL -lc`, falling back to `/bin/sh`, or on
/// Windows through `%COMSPEC% /C`, in the folder it sets. Fails when the path is not UTF-8 text or
/// a word cannot be written for the system's command shell.
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

/// The hooks the daemon starts the terminal service with: none while its program dispatches no
/// hook mode, as `dispatches_hook_mode` says, else the hooks that run that program as it started,
/// read from where it runs now. Fails when the system cannot name the program or its hook commands
/// cannot be written.
pub(crate) fn read_terminal_service_hooks(
    dispatches_hook_mode: bool,
) -> Result<TerminalServiceHooks, HookCommandError> {
    if !CodexServiceKind::Terminal.runs_daemon_hooks(dispatches_hook_mode) {
        return Ok(TerminalServiceHooks::NoHooks);
    }
    match read_running_program_path().map_err(HookCommandError::ProgramUnread)? {
        RunningProgramPath::OnDisk(path) => Ok(TerminalServiceHooks::Daemon(
            compose_daemon_hook_commands(&path)?,
        )),
        RunningProgramPath::Replaced => Ok(TerminalServiceHooks::ProgramReplaced),
    }
}

/// Whether the lasting service a daemon finds running can be joined, from `listed`, the hooks its
/// command line set: with `hooks` none, only when it lists none; with the daemon's, only when each
/// of the daemon's events has a hook listed whose command and timeout are the ones composed; never
/// once the daemon's program was replaced. Any difference answers
/// [`LastingServiceVerdict::Restart`], which the daemon's start hands to the planned restart.
/// Never reproduces Codex's own hook hash.
pub(crate) fn compare_daemon_hook_commands(
    listed: &[CodexListedHook],
    hooks: &TerminalServiceHooks,
) -> LastingServiceVerdict {
    let composed = match hooks {
        TerminalServiceHooks::NoHooks if listed.is_empty() => return LastingServiceVerdict::Adopt,
        TerminalServiceHooks::NoHooks | TerminalServiceHooks::ProgramReplaced => {
            return LastingServiceVerdict::Restart;
        }
        TerminalServiceHooks::Daemon(composed) => composed,
    };
    let timeout_seconds = CODEX_HOOK_TIMEOUT.as_secs();
    let is_every_event_listed = composed.events().iter().all(|(event_name, command)| {
        listed.iter().any(|hook| {
            hook.event_name == *event_name
                && hook.command == *command
                && hook.timeout_seconds == timeout_seconds
        })
    });
    if is_every_event_listed {
        LastingServiceVerdict::Adopt
    } else {
        LastingServiceVerdict::Restart
    }
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

/// What one service start carries beyond the switches every service the daemon starts shares.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexServiceCommandLineInput {
    /// `unix://` for the home's own control socket, or `unix://<path>` for a second service that
    /// starts beside the first on one home.
    pub(crate) listen_address: String,
    /// More `key=value` switches another part of the daemon adds, such as the telemetry export or
    /// the terminal service's hooks.
    pub(crate) additional_config_overrides: Vec<String>,
}

/// One matcher group of a hook event, as Codex's `hooks` table reads it.
#[derive(Serialize)]
struct CodexHookMatcher<'command> {
    matcher: &'static str,
    hooks: [CodexCommandHook<'command>; 1],
}

/// One command hook, whose line Codex runs on every system.
#[derive(Serialize)]
struct CodexCommandHook<'command> {
    #[serde(rename = "type")]
    hook_type: &'static str,
    command: &'command str,
    timeout: i64,
}

/// The arguments after the Codex command for one service the daemon starts. A conversation on a
/// managed account home gets its hooks from its own start, so no hook switch is composed here.
pub(crate) fn compose_codex_service_arguments(input: &CodexServiceCommandLineInput) -> Vec<String> {
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
    let overrides = shared_overrides
        .into_iter()
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
                .expect("10^12 seconds is a 64-bit integer"),
        }],
    }];
    let mut value = String::new();
    hook.serialize(toml::ser::ValueSerializer::new(&mut value))
        .expect("a hook's strings and integer are TOML values");
    format!("hooks.{event_name}={value}")
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use rstest::rstest;

    use super::{
        CODEX_HOOK_TIMEOUT, CodexHookCommands, CodexListedHook, CodexServiceCommandLineInput,
        LastingServiceVerdict, TerminalServiceHooks, compare_daemon_hook_commands,
        compose_codex_service_arguments, compose_daemon_hook_commands,
    };

    /// The daemon's program in the comparison's cases.
    const PROGRAM: &str = "/opt/sidekicks/sidekicks-daemon";

    // Fails when adopt is answered without reading the list, when the event alone is compared,
    // when the daemon joins a service whose hooks run a program since replaced, or when a daemon
    // that runs no hooks joins a service still running a former daemon's.
    #[rstest]
    #[case::the_same_hooks(
        Some(""),
        CODEX_HOOK_TIMEOUT.as_secs(),
        "daemon",
        LastingServiceVerdict::Adopt
    )]
    #[case::another_program(
        Some("-old"),
        CODEX_HOOK_TIMEOUT.as_secs(),
        "daemon",
        LastingServiceVerdict::Restart
    )]
    #[case::another_timeout(Some(""), 600, "daemon", LastingServiceVerdict::Restart)]
    #[case::a_replaced_program(
        Some(""),
        CODEX_HOOK_TIMEOUT.as_secs(),
        "replaced",
        LastingServiceVerdict::Restart
    )]
    #[case::no_hooks_and_none_listed(None, 0, "none", LastingServiceVerdict::Adopt)]
    #[case::no_hooks_and_a_former_daemon_s_listed(
        Some(""),
        CODEX_HOOK_TIMEOUT.as_secs(),
        "none",
        LastingServiceVerdict::Restart
    )]
    fn compare_daemon_hook_commands_adopts_only_the_same_hooks(
        #[case] listed_program_suffix: Option<&str>,
        #[case] timeout_seconds: u64,
        #[case] hooks: &str,
        #[case] expected: LastingServiceVerdict,
    ) {
        let listed: Vec<CodexListedHook> = listed_program_suffix
            .map(|suffix| {
                compose_daemon_hook_commands(&PathBuf::from(format!("{PROGRAM}{suffix}")))
                    .expect("the path is text")
                    .events()
                    .iter()
                    .map(|(event_name, command)| CodexListedHook {
                        event_name: (*event_name).to_owned(),
                        command: (*command).to_owned(),
                        timeout_seconds,
                    })
                    .collect()
            })
            .unwrap_or_default();
        let hooks = match hooks {
            "daemon" => TerminalServiceHooks::Daemon(
                compose_daemon_hook_commands(Path::new(PROGRAM)).expect("the path is text"),
            ),
            "replaced" => TerminalServiceHooks::ProgramReplaced,
            _ => TerminalServiceHooks::NoHooks,
        };

        let verdict = compare_daemon_hook_commands(&listed, &hooks);

        assert_eq!(verdict, expected);
    }

    // Fails when a command's text changes on its way through TOML, when either hold moves off the
    // fixed 10^12 seconds and 10^15 milliseconds, or when a service's own line gains a hook.
    #[test]
    fn the_hook_override_reads_back_its_command_and_timeout_unchanged() {
        let command = "/opt/hooks/run \"quoted\" C:\\hooks\\run.exe \u{7f}end";
        let overrides = CodexHookCommands {
            pre_tool_use: command.to_owned(),
            post_tool_use: "/opt/hooks/after".to_owned(),
        }
        .config_overrides();
        let arguments = compose_codex_service_arguments(&CodexServiceCommandLineInput {
            listen_address: "unix://".to_owned(),
            additional_config_overrides: Vec::new(),
        });
        let pre_tool_use = overrides
            .iter()
            .find(|argument| argument.starts_with("hooks.PreToolUse="))
            .expect("the pre-tool hook has its switch");

        let config: toml::Table = toml::from_str(pre_tool_use).expect("the switch is TOML");
        let hook = &config["hooks"]["PreToolUse"][0]["hooks"][0];

        assert_eq!(hook["command"].as_str(), Some(command));
        assert_eq!(hook["timeout"].as_integer(), Some(1_000_000_000_000));
        assert!(arguments.contains(
            &"features.code_mode.default_exec_yield_time_ms=1000000000000000".to_owned()
        ));
        assert!(
            !arguments
                .iter()
                .any(|argument| argument.starts_with("hooks.")),
            "{arguments:?}"
        );
    }
}
