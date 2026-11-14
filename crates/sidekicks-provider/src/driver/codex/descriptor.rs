//! Codex's fixed facts: its command, folders, sandbox, environment, tool servers and the names
//! it writes.

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
use crate::driver::codex::mcp::server_name::CODEX_MCP_SERVER_NAMES;
use crate::driver::codex::release_notes::release_notes_address;
use crate::driver::codex::service::registry::CODEX_SWITCHING_HOME_FOLDER;
use crate::driver::codex::tools::CODEX_BUILT_IN_TOOLS;
use crate::driver::codex::written_names::CODEX_WRITTEN_NAME_FORMS;
use crate::driver::command_sandbox::CommandSandboxNeeds;
use crate::driver::{
    InstallFolder, InstallFolderBase, ProviderCommand, ProviderCommandLookup, ProviderDescriptor,
    ProviderMemoryEstimates, ProviderSwitchBoundaries,
};

/// Codex's fixed facts.
pub(crate) const DESCRIPTOR: ProviderDescriptor = ProviderDescriptor {
    id: "codex",
    name: "Codex",
    release_notes_address,
    plan_words: &[
        ("free", "Free"),
        ("go", "Go"),
        ("plus", "Plus"),
        ("prolite", "Pro"),
        ("pro", "Pro (More)"),
        ("promax", "Pro (Max)"),
        ("team", "Business"),
        ("self_serve_business_usage_based", "Business"),
        ("self_serve_business_prolite", "Business Premium"),
        ("business", "Enterprise"),
        ("ent26", "Enterprise"),
        ("enterprise_cbp_usage_based", "Enterprise"),
        ("enterprise", "Enterprise"),
        ("enterprise_cbp_automation", "Enterprise (Automation)"),
        ("edu", "Edu"),
        ("edu_plus", "Edu Plus"),
        ("edu_pro", "Edu Pro"),
    ],
    built_in_tools: &CODEX_BUILT_IN_TOOLS,
    command: ProviderCommand {
        windows: Some(ProviderCommandLookup {
            names: &["codex"],
            install_folders: &[InstallFolder {
                base: InstallFolderBase::UserPrograms,
                components: &["OpenAI", "Codex", "bin"],
            }],
        }),
        unix: Some(ProviderCommandLookup {
            names: &["codex"],
            install_folders: &[InstallFolder {
                base: InstallFolderBase::Home,
                components: &[".local", "bin"],
            }],
        }),
    },
    // Where its system `config.toml` and `requirements.toml` sit; macOS reads the Unix folder.
    managed_settings_folders: SystemFolders {
        macos: Some(SystemFolder {
            base: MacosSystemFolder::Etc,
            components: &["codex"],
        }),
        linux: Some(SystemFolder {
            base: LinuxSystemFolder::Etc,
            components: &["codex"],
        }),
        windows: Some(SystemFolder {
            base: WindowsSystemFolder::ProgramData,
            components: &["OpenAI", "Codex"],
        }),
    },
    // It sandboxes its commands on every system with helpers of its own, its own bubblewrap among
    // them, which on Linux makes a user namespace.
    command_sandbox: PerSystem {
        macos: true,
        linux: true,
        windows: true,
    },
    command_sandbox_needs: PerSystem {
        macos: CommandSandboxNeeds::NOTHING,
        linux: CommandSandboxNeeds {
            programs: &[],
            user_namespace: true,
            service_readiness: false,
        },
        // On Windows its sandbox needs a setup the service reports: the driver asks the service's
        // `windowsSandbox/readiness` over its connection, and offers the sandbox only on `Ready`,
        // never on `NotConfigured` or `UpdateRequired`.
        windows: CommandSandboxNeeds {
            programs: &[],
            user_namespace: false,
            service_readiness: true,
        },
    },
    // The whole service measured at 53 to 61 MB, and each conversation on a running service at
    // 1.8 to 3.0 MB more.
    memory: ProviderMemoryEstimates {
        process_bytes: 61_000_000,
        conversation_bytes: Some(3_000_000),
    },
    // Listed first on every model that publishes a tier, and requested by clearing the thread's.
    standard_output_speed: "default",
    // Its `turn/interrupt` leaves a helper interrupted, and a send continues it.
    stop_all_row_word: ChildStoppedState::Interrupted,
    // It lists its service tiers on each model of its catalog.
    output_speed_levels: None,
    // Each turn carries the model, effort, service tier and window it runs on.
    switch_boundaries: ProviderSwitchBoundaries {
        model_id: AgentBindingSwitchBoundary::TurnBoundary,
        effort: AgentBindingSwitchBoundary::TurnBoundary,
        output_speed: AgentBindingSwitchBoundary::TurnBoundary,
        options: AgentBindingSwitchBoundary::TurnBoundary,
        larger_window: AgentBindingSwitchBoundary::TurnBoundary,
    },
    // It documents no update switch; the driver runs one exact build path instead.
    process_environment: &[],
    // Carries the app-server binary's path into the launch prelude, which never interpolates it;
    // and opens the shutdown request on the lasting service's control socket, which Codex reads on
    // Windows alone.
    launch_environment_names: &["CODEX_APP_SERVER_BIN", "CODEX_DAEMON_SHUTDOWN_SOCKET"],
    // The account's own `CODEX_HOME`.
    credential_home_environment_names: &["CODEX_HOME"],
    withheld_environment_names: &[
        // Sends the service's sign-in to another issuer than the one its login names.
        "CODEX_APP_SERVER_LOGIN_ISSUER",
    ],
    screen_reader_environment_names: &[],
    voice_kinds: &[VoiceKind::Call],
    // It reaches no server over server-sent events.
    mcp_transports: &[McpTransport::Stdio, McpTransport::Http],
    mcp_config_members: &[
        McpDeclaredConfigMember::EnvVars,
        McpDeclaredConfigMember::Required,
        McpDeclaredConfigMember::StartupTimeoutSec,
        McpDeclaredConfigMember::ToolTimeoutSec,
        McpDeclaredConfigMember::BearerTokenEnvVar,
        McpDeclaredConfigMember::EnvHttpHeaders,
        McpDeclaredConfigMember::OauthScopes,
        McpDeclaredConfigMember::OauthResource,
    ],
    mcp_server_names: CODEX_MCP_SERVER_NAMES,
    // It has no `local` scope: a project's `local` server is a user entry, off, switched on in the
    // sessions of that project alone.
    is_mcp_local_scope_emulated: true,
    // Each call's `mcp_servers` table carries the session's set.
    takes_session_tool_servers: true,
    // Codex's own limit on a skill's name.
    skill_name_max_length: Some(64),
    written_name_forms: &CODEX_WRITTEN_NAME_FORMS,
    permission_identifiers: &[
        "sandbox_permissions",
        "sandbox_mode",
        "request_user_input",
        "<proposed_plan>",
    ],
    background_work: None,
    callback_tools_asked: false,
    // Its tool search defers a whole tool-server entry, never one tool of it.
    agent_tool_loading: AgentToolLoading::EntryPerLoading,
    // It pastes a server's `instructions` into every tool's description, so the rules go as the
    // conversation's `developerInstructions`.
    agent_tool_instructions: AgentToolInstructions::OnConversation,
    // A held call costs it a model pass about a minute, so a wait answers at once and wakes it.
    agent_tool_wait: AgentToolWait::AnsweredThenWoken,
    // It cuts a call at its entry's `tool_timeout_sec`, so the daemon answers a long one with a
    // task handle.
    agent_tool_long_call: AgentToolLongCall::DaemonHandle,
    // It has no wake-up tool of its own.
    own_wake_up_tool: None,
    // Its login runs its own loopback listener for the browser's return.
    can_mcp_sign_in_return_to_daemon_receiver: false,
    // Codex's log folder; the rows its service logs into the home's database the driver's own
    // expiry deletes.
    account_home_diagnostic_folders: &[&["log"]],
    // Each thread's rollout, a spawned child thread's under its own id.
    account_home_conversation_folders: &[&["sessions"]],
    // Its memories stay each home's own, read in by the memory import.
    account_home_memory_folder: None,
    // The home of the one service every session that follows the current account runs in.
    switching_home_folder: Some(CODEX_SWITCHING_HOME_FOLDER),
    // `auth.json` sits in the home `CODEX_HOME` names.
    account_home_credential_store_folder: &[],
    shell_prefix_command: None,
    terminal_resume_command: "codex resume",
};
