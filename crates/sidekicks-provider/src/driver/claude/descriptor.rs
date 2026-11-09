//! Claude Code's fixed facts: its command, folders, sandbox, environment, tool servers and the
//! forms of work it is kept from starting outside a session.

use sidekicks_contracts::agent::provider_binding::AgentBindingSwitchBoundary;
use sidekicks_contracts::mcp::server::config::{McpDeclaredConfigMember, McpTransport};
use sidekicks_contracts::run::children::ChildStoppedState;
use sidekicks_contracts::voice::VoiceKind;
use sidekicks_platforms::{
    LinuxSystemFolder, MacosSystemFolder, PerSystem, SystemFolder, SystemFolders,
    WindowsSystemFolder,
};

use crate::driver::agent_tools::{
    AgentToolInstructions, AgentToolLoading, AgentToolLongCall, AgentToolWait,
};
use crate::driver::claude::account::credentials::{
    CONFIG_FOLDER_VARIABLE, OAUTH_TOKEN_VARIABLE, SECURE_STORAGE_FOLDER_VARIABLE,
};
use crate::driver::claude::command_shape::CLAUDE_SHELL_PREFIX_COMMAND;
use crate::driver::claude::mcp::server_name::CLAUDE_MCP_SERVER_NAMES;
use crate::driver::claude::release_notes::release_notes_address;
use crate::driver::claude::spawn::environment::{
    CLAUDE_OAUTH_TOKEN_DESCRIPTOR_VARIABLE, CLAUDE_RESUME_INTERRUPTED_TURN_KEY,
    CLAUDE_RESUME_MAX_AGE_KEY, CLAUDE_RESUME_PROMPT_KEY, CLAUDE_RESUME_SHOWS_CUT_OFF_CALLS_KEY,
};
use crate::driver::claude::tools::CLAUDE_BUILT_IN_TOOLS;
use crate::driver::claude::written_names::CLAUDE_WRITTEN_NAME_FORMS;
use crate::driver::{
    BackgroundWork, CommandSandboxNeeds, InstallFolder, InstallFolderBase, ProviderCommand,
    ProviderCommandLookup, ProviderDescriptor, ProviderMemoryEstimates, ProviderSwitchBoundaries,
};

/// Claude Code's fixed facts. Its plan ids read as their own words, and it reads no tool-server
/// declaration member beyond the shared ones.
pub(crate) const DESCRIPTOR: ProviderDescriptor = ProviderDescriptor {
    id: "claude",
    name: "Claude Code",
    release_notes_address,
    plan_words: &[],
    built_in_tools: &CLAUDE_BUILT_IN_TOOLS,
    command: ProviderCommand {
        windows: Some(ProviderCommandLookup {
            names: &["claude"],
            install_folders: &[InstallFolder {
                base: InstallFolderBase::Home,
                components: &[".local", "bin"],
            }],
        }),
        unix: Some(ProviderCommandLookup {
            names: &["claude"],
            install_folders: &[
                InstallFolder {
                    base: InstallFolderBase::Home,
                    components: &[".local", "bin"],
                },
                // Claude Code's own local install.
                InstallFolder {
                    base: InstallFolderBase::Home,
                    components: &[".claude", "local"],
                },
            ],
        }),
    },
    // Where `managed-settings.json`, `managed-settings.d/` and `managed-mcp.json` sit.
    managed_settings_folders: SystemFolders {
        macos: Some(SystemFolder {
            base: MacosSystemFolder::ApplicationSupport,
            components: &["ClaudeCode"],
        }),
        linux: Some(SystemFolder {
            base: LinuxSystemFolder::Etc,
            components: &["claude-code"],
        }),
        windows: Some(SystemFolder {
            base: WindowsSystemFolder::ProgramFiles,
            components: &["ClaudeCode"],
        }),
    },
    // Seatbelt on macOS and bubblewrap on Linux; on Windows it runs commands unsandboxed.
    command_sandbox: PerSystem {
        macos: true,
        linux: true,
        windows: false,
    },
    // On Linux its sandbox runs the system's bubblewrap and socat in a user namespace; macOS
    // ships Seatbelt.
    command_sandbox_needs: PerSystem {
        macos: CommandSandboxNeeds::NOTHING,
        linux: CommandSandboxNeeds {
            programs: &["bwrap", "socat"],
            user_namespace: true,
            service_readiness: false,
        },
        windows: CommandSandboxNeeds::NOTHING,
    },
    // Each conversation is a process of its own, measured at a peak of 182 MB.
    memory: ProviderMemoryEstimates {
        process_bytes: 182_000_000,
        conversation_bytes: None,
    },
    standard_output_speed: "off",
    // Its `stop_task` ends a child for good; it refuses every later message to that child.
    stop_all_row_word: ChildStoppedState::Stopped,
    // Its declared state has a third value, which the provider enters after a rate limit and no
    // request asks for.
    output_speed_levels: Some(&["off", "on"]),
    // Claude Code takes each in its running process between turns.
    switch_boundaries: ProviderSwitchBoundaries {
        model_id: AgentBindingSwitchBoundary::TurnBoundary,
        effort: AgentBindingSwitchBoundary::TurnBoundary,
        output_speed: AgentBindingSwitchBoundary::TurnBoundary,
        options: AgentBindingSwitchBoundary::TurnBoundary,
        larger_window: AgentBindingSwitchBoundary::TurnBoundary,
    },
    process_environment: &[
        // Its two update switches, so the build recorded at start is the one that runs.
        ("DISABLE_AUTOUPDATER", "1"),
        ("DISABLE_UPDATES", "1"),
        // A tool-server call or a helper still running after 120 s moves to the background.
        ("CLAUDE_AUTO_BACKGROUND_TASKS", "1"),
        // Set, the variable decides the cross-session inbox, so a remote flag cannot close it.
        ("CLAUDE_CODE_HARBOR_KITE", "1"),
        // A waiting dialog arms no deadline.
        ("CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS", "0"),
        // A background command's `timeout` is honored up to Claude Code's own cap.
        ("BASH_MAX_TIMEOUT_MS", "2147483647"),
        // The question tool's two switches: options carry markdown previews, and the tool also
        // asks text and number questions under a title; unset, a process asks neither.
        ("CLAUDE_CODE_QUESTION_PREVIEW_FORMAT", "markdown"),
        ("CLAUDE_CODE_QUESTION_EXTENDED", "1"),
        // Claude Code's own helper caps are lifted: the daemon applies the person's limit itself,
        // and nothing bounds how deep helpers nest.
        (
            "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH",
            "9223372036854775807",
        ),
        (
            "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS",
            "9223372036854775807",
        ),
    ],
    launch_environment_names: &[],
    // The account's configuration home, its credential store, and the scratch folder the daemon
    // keeps per account home, so a session's temporary files sit where its purge finds them.
    credential_home_environment_names: &[
        CONFIG_FOLDER_VARIABLE,
        SECURE_STORAGE_FOLDER_VARIABLE,
        "CLAUDE_CODE_TMPDIR",
    ],
    withheld_environment_names: &[
        // Forces the permission mode to `default`.
        "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
        // Ends a process that holds a pending wake-up.
        "CLAUDE_CODE_EXIT_AFTER_STOP_DELAY",
        // Hands a flagged removal to the auto-mode classifier.
        "CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT",
        // Joins the per-session memories the daemon keeps apart.
        "CLAUDE_CODE_REMOTE_MEMORY_DIR",
        // A shell's own sign-in token, which would beat the account's.
        OAUTH_TOKEN_VARIABLE,
        // Names the pipe a pasted token is handed on, which only the daemon's start sets.
        CLAUDE_OAUTH_TOKEN_DESCRIPTOR_VARIABLE,
        // Continue an interrupted turn, which only a resume's own process does.
        CLAUDE_RESUME_INTERRUPTED_TURN_KEY,
        CLAUDE_RESUME_SHOWS_CUT_OFF_CALLS_KEY,
        CLAUDE_RESUME_PROMPT_KEY,
        CLAUDE_RESUME_MAX_AGE_KEY,
    ],
    screen_reader_environment_names: &["CLAUDE_AX_SCREEN_READER"],
    voice_kinds: &[VoiceKind::Dictation],
    mcp_transports: &[McpTransport::Stdio, McpTransport::Http, McpTransport::Sse],
    // It reads a remote entry's `oauth.scopes`.
    mcp_config_members: &[McpDeclaredConfigMember::OauthScopes],
    mcp_server_names: CLAUDE_MCP_SERVER_NAMES,
    // It keeps a project's `local` servers in its own config.
    is_mcp_local_scope_emulated: false,
    // Its start sends no `--mcp-config` of the person's servers yet.
    takes_session_tool_servers: false,
    skill_name_max_length: None,
    written_name_forms: &CLAUDE_WRITTEN_NAME_FORMS,
    permission_identifiers: &[
        "ExitPlanMode",
        "plan mode",
        "permission mode",
        "auto-accept",
    ],
    callback_tools_asked: true,
    // A tool whose listing carries this `_meta` key set to `true` is sent in full, never deferred
    // behind its tool search.
    agent_tool_loading: AgentToolLoading::MarkedOnListing {
        meta_key: "anthropic/alwaysLoad",
    },
    // It reads a tool server's `instructions` from the connection's `initialize` answer.
    agent_tool_instructions: AgentToolInstructions::OnConnection,
    // A held call costs it no model pass, so a wait holds the call open.
    agent_tool_wait: AgentToolWait::Held,
    // A tool-server call still running after 120 s moves to its own background task.
    agent_tool_long_call: AgentToolLongCall::ProviderBackgrounds,
    // Its own wake-up tool, so it is not offered the daemon's reminder tool.
    own_wake_up_tool: Some("ScheduleWakeup"),
    // Its sign-in takes the daemon's receiver's address when the authorization server accepts it.
    can_mcp_sign_in_return_to_daemon_receiver: true,
    background_work: Some(BackgroundWork {
        // Background sessions and their supervisor, a restart of them, and every form that serves
        // or runs a session from elsewhere: Remote Control, a self-hosted runner, the gateway.
        subcommands: &[
            "agents",
            "daemon",
            "respawn",
            "remote-control",
            "self-hosted-runner",
            "gateway",
        ],
        // A prompt sent to the background (`--exec` runs only beside `--bg`), to Remote Control,
        // to the cloud, or taken over from it.
        flags: &[
            "--bg",
            "--background",
            "--remote-control",
            "--rc",
            "--cloud",
            "--remote",
            "--teleport",
        ],
        refusal: "`claude agents`, `claude daemon`, `claude --bg` and every other `claude` form \
                  that starts or serves work outside this session are refused inside it: their \
                  work would run outside the session's agents, outside Stop and Interrupt, and \
                  off its receipt.",
        // Turns off `claude agents`, `--bg`, `/background` and the on-demand supervisor; no
        // setting turns them back on.
        off_switch: ("CLAUDE_CODE_DISABLE_AGENT_VIEW", "1"),
    }),
    // Large pastes, shell snapshots, feedback bundles and drafts, and `/insights` reports: Claude
    // Code's own age-swept folders that hold no session's files. `debug/` is not among them: it
    // holds one log per session, which `delete_claude_conversations` deletes with its session.
    account_home_diagnostic_folders: &[
        &["paste-cache"],
        &["shell-snapshots"],
        &["feedback-bundles"],
        &["feedback", "drafts"],
        &["usage-data"],
    ],
    // Transcripts with their subagents' and tools' files, the pre-edit snapshots a checkpoint
    // restores, task lists, uploads and dev mods, each kept per conversation.
    account_home_conversation_folders: &[
        &["projects"],
        &["file-history"],
        &["tasks"],
        &["uploads"],
        &["dev-mods"],
    ],
    // Each agent's user-scope memory, which every account's agents share with the daemon's own.
    account_home_memory_folder: Some(&["agent-memory"]),
    switching_home_folder: None,
    // The sign-in's own folder, which `CLAUDE_SECURESTORAGE_CONFIG_DIR` names.
    account_home_credential_store_folder: &["store"],
    shell_prefix_command: Some(CLAUDE_SHELL_PREFIX_COMMAND),
    terminal_resume_command: "claude --resume",
};
