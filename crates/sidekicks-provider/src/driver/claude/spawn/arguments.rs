//! The command line a Claude Code session process starts with: stream-json both ways with the
//! person's messages replayed, every permission prompt sent to the daemon, the level's permission
//! mode, the session's model and settings, and how the conversation starts. No tool server is named
//! on it: the daemon's servers ride Claude Code's in-process route, named at `initialize`.

use std::path::Path;

use serde_json::{Map, Value};

use crate::driver::claude::session::transport::control::ClaudePermissionMode;
use crate::driver::claude::spawn::settings::ClaudeSpawnSettings;
use crate::driver::claude::spawn::system_prompt::claude_appended_system_prompt_arguments;

/// How a spawn's conversation starts: a new one, a resume of one, one kept nowhere (a throwaway
/// copy of a conversation or a new one), or a fork at one message.
pub(crate) enum ClaudeConversationStart {
    /// A new conversation under the id the daemon chose.
    New {
        /// The conversation's id.
        provider_session_id: String,
    },
    /// A conversation Claude Code keeps no file of: a one-turn copy of `resume_handle`'s, or a new
    /// one where there is none.
    Unkept {
        /// The conversation copied.
        resume_handle: Option<String>,
    },
    /// A resume of an existing conversation.
    Resume {
        /// The conversation resumed.
        resume_handle: String,
    },
    /// A fork of a conversation at one message, the successor of a rewind, which discards the turn
    /// of one prompt.
    Fork {
        /// The conversation forked.
        resume_handle: String,
        /// The id the fork is pinned to, so the transport knows it before any turn.
        forked_provider_session_id: String,
        /// The entry the fork keeps the conversation up to.
        resume_at_message_uuid: String,
        /// The prompt whose turn the fork discards; Claude Code refuses the fork where that range
        /// holds anything else.
        dropped_turn_prompt_uuid: String,
    },
}

/// What one spawn's command line is composed from.
pub(crate) struct ClaudeArgumentsRequest<'a> {
    /// The session's model.
    pub(crate) model: &'a str,
    /// The mode the process runs in, as `--permission-mode` names it.
    pub(crate) permission_mode: ClaudePermissionMode,
    /// The `--settings` document.
    pub(crate) settings: &'a ClaudeSpawnSettings,
    /// The session's output schema.
    pub(crate) output_schema: Option<&'a Map<String, Value>>,
    /// Whether helpers are off, so the helper tool is not offered at all.
    pub(crate) is_helper_tool_withheld: bool,
    /// The session's step bound, `None` where it sets none.
    pub(crate) step_bound: Option<u32>,
    /// Whether a readable `managed-mcp.json` sits in the managed settings folder, under which
    /// Claude Code exits at startup when told to load only the servers it is given.
    pub(crate) has_managed_mcp_file: bool,
    /// How the conversation starts.
    pub(crate) conversation: ClaudeConversationStart,
    /// The socket the process listens on for other sessions' messages, which the daemon chose;
    /// `None` leaves Claude Code its own.
    pub(crate) messaging_socket: Option<&'a Path>,
}

/// The arguments after the executable. No budget cap, background run, auto-mode opt-in, prompt
/// opt-out or tool-server file is ever passed.
pub(crate) fn compose_claude_arguments(request: &ClaudeArgumentsRequest<'_>) -> Vec<String> {
    let mut arguments: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--replay-user-messages",
        // Streams each response as `stream_event` frames, so its text is stored as it is written.
        "--include-partial-messages",
        // Sends every permission prompt to the daemon as `can_use_tool`; it is also what offers the
        // question tool to a headless process.
        "--permission-prompt-tool",
        "stdio",
        "--permission-mode",
    ]
    .map(str::to_owned)
    .into();
    arguments.push(<&str>::from(request.permission_mode).to_owned());
    arguments.push("--model".to_owned());
    arguments.push(request.model.to_owned());
    arguments.extend(claude_appended_system_prompt_arguments().map(str::to_owned));
    arguments.push("--settings".to_owned());
    arguments.push(
        serde_json::to_string(request.settings).expect("the settings document always serializes"),
    );
    arguments.extend(
        conversation_arguments(&request.conversation)
            .into_iter()
            .map(str::to_owned),
    );
    // Loads no MCP file of the person's own. A deployed managed file already keeps them out, and
    // under it this flag makes Claude Code exit at startup.
    if !request.has_managed_mcp_file {
        arguments.push("--strict-mcp-config".to_owned());
    }
    if let Some(schema) = request.output_schema {
        arguments.push("--json-schema".to_owned());
        arguments.push(serde_json::to_string(schema).expect("a JSON object always serializes"));
    }
    // The wire names the helper tool `Agent` while `system/init` advertises it as `Task`.
    if request.is_helper_tool_withheld {
        arguments.extend(["--disallowedTools", "Agent", "Task"].map(str::to_owned));
    }
    // The daemon counts the steps and stops the run at its bound itself; Claude Code's own limit,
    // one higher, is only the backstop.
    if let Some(bound) = request.step_bound {
        arguments.push("--max-turns".to_owned());
        arguments.push((u64::from(bound) + 1).to_string());
    }
    // Pins the socket, with no fallback, so the daemon's inbox knows where to pass a message to
    // before the process writes anything.
    if let Some(socket) = request.messaging_socket {
        arguments.push("--messaging-socket-path".to_owned());
        arguments.push(socket.display().to_string());
    }
    arguments
}

fn conversation_arguments(conversation: &ClaudeConversationStart) -> Vec<&str> {
    match conversation {
        ClaudeConversationStart::New {
            provider_session_id,
        } => vec!["--session-id", provider_session_id.as_str()],
        ClaudeConversationStart::Resume { resume_handle } => {
            vec!["--resume", resume_handle.as_str()]
        }
        ClaudeConversationStart::Unkept {
            resume_handle: None,
        } => vec!["--no-session-persistence"],
        ClaudeConversationStart::Unkept {
            resume_handle: Some(resume_handle),
        } => vec![
            "--resume",
            resume_handle.as_str(),
            "--fork-session",
            "--no-session-persistence",
        ],
        ClaudeConversationStart::Fork {
            resume_handle,
            forked_provider_session_id,
            resume_at_message_uuid,
            dropped_turn_prompt_uuid,
        } => vec![
            "--resume",
            resume_handle.as_str(),
            "--fork-session",
            "--session-id",
            forked_provider_session_id.as_str(),
            "--resume-session-at",
            resume_at_message_uuid.as_str(),
            "--resume-drops-turn",
            dropped_turn_prompt_uuid.as_str(),
        ],
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use rstest::rstest;

    use super::{
        ClaudeArgumentsRequest, ClaudeConversationStart, claude_appended_system_prompt_arguments,
        compose_claude_arguments,
    };
    use crate::driver::claude::session::transport::control::{
        ClaudePermissionMode, ClaudePermissionsDocument,
    };
    use crate::driver::claude::spawn::settings::{
        AgentViewOff, CLAUDE_CLEANUP_PERIOD_DAYS, ClaudeSpawnSettings,
    };

    // The arguments every process starts with, `--settings`'s document the last.
    const LEADING_ARGUMENTS: usize = 18;

    // Killed by a `--max-turns` of the bound itself, by a leftover daemon `--mcp-config` entry, by
    // `--strict-mcp-config` under a managed file (Claude Code's startup exit), by a fork that
    // drops `--resume-drops-turn` or writes it before `--resume-session-at`, and by any start's
    // list changing, by a start that does not append the long-running-commands section, and by a
    // daemon-chosen messaging socket left off the line.
    #[rstest]
    #[case::new(
        ClaudeConversationStart::New { provider_session_id: "s1".to_owned() },
        false,
        None,
        None,
        &["--session-id", "s1", "--strict-mcp-config"],
    )]
    #[case::resume(
        ClaudeConversationStart::Resume { resume_handle: "s1".to_owned() },
        true,
        Some(9),
        Some("/tmp/cc-socks/a0.sock"),
        &[
            "--resume",
            "s1",
            "--max-turns",
            "10",
            "--messaging-socket-path",
            "/tmp/cc-socks/a0.sock",
        ],
    )]
    #[case::unkept_new(
        ClaudeConversationStart::Unkept { resume_handle: None },
        false,
        None,
        None,
        &["--no-session-persistence", "--strict-mcp-config"],
    )]
    #[case::unkept_copy(
        ClaudeConversationStart::Unkept { resume_handle: Some("s1".to_owned()) },
        true,
        None,
        None,
        &["--resume", "s1", "--fork-session", "--no-session-persistence"],
    )]
    #[case::fork(
        ClaudeConversationStart::Fork {
            resume_handle: "s1".to_owned(),
            forked_provider_session_id: "s2".to_owned(),
            resume_at_message_uuid: "m1".to_owned(),
            dropped_turn_prompt_uuid: "p1".to_owned(),
        },
        false,
        Some(1),
        None,
        &[
            "--resume", "s1", "--fork-session", "--session-id", "s2", "--resume-session-at", "m1",
            "--resume-drops-turn", "p1", "--strict-mcp-config", "--max-turns", "2",
        ],
    )]
    fn each_start_composes_its_own_tail(
        #[case] conversation: ClaudeConversationStart,
        #[case] has_managed_mcp_file: bool,
        #[case] step_bound: Option<u32>,
        #[case] messaging_socket: Option<&str>,
        #[case] tail: &[&str],
    ) {
        let settings = ClaudeSpawnSettings {
            cleanup_period_days: CLAUDE_CLEANUP_PERIOD_DAYS,
            disable_agent_view: AgentViewOff,
            permissions: ClaudePermissionsDocument {
                allow: Vec::new(),
                ask: Vec::new(),
                deny: Vec::new(),
            },
            advisor_model: Some(String::new()),
            output_style: None,
            sandbox: None,
        };
        let request = ClaudeArgumentsRequest {
            model: "opus",
            permission_mode: ClaudePermissionMode::Default,
            settings: &settings,
            output_schema: None,
            is_helper_tool_withheld: false,
            step_bound,
            has_managed_mcp_file,
            conversation,
            messaging_socket: messaging_socket.map(Path::new),
        };

        let arguments = compose_claude_arguments(&request);

        assert_eq!(arguments[LEADING_ARGUMENTS - 2], "--settings");
        assert_eq!(
            arguments[LEADING_ARGUMENTS - 4..LEADING_ARGUMENTS - 2],
            claude_appended_system_prompt_arguments(),
        );
        assert_eq!(&arguments[LEADING_ARGUMENTS..], tail);
        assert!(!arguments.iter().any(|argument| argument == "--mcp-config"));
    }
}
