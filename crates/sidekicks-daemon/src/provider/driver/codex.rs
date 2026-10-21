//! The Codex driver, over the one shared Codex app-server every session reaches by its socket.

use sidekicks_contracts::mcp::server::config::{McpDeclaredConfigMember, McpTransport};
use sidekicks_contracts::voice::VoiceKind;
use sidekicks_platforms::{
    LinuxSystemFolder, MacosSystemFolder, PerSystem, SystemFolder, SystemFolders,
    WindowsSystemFolder,
};

use crate::provider::driver::{
    CommandSandboxNeeds, InstallFolder, InstallFolderBase, ProviderCommand, ProviderCommandLookup,
    ProviderDescriptor, ProviderMemoryEstimates,
};

mod app_server_protocol;
mod ask_option_sets;
mod capabilities;
mod capability_probe;
mod commands;
mod delivery;
mod event_normalizer;
mod hooks;
mod input_limit;
mod intervention;
mod native_program;
mod permission_level;
mod rules;
mod run;
mod server_requests;
mod service;
mod session;
mod thread;
mod tools;
mod transport;
mod turn_evidence;
mod usage_limit_signal;
#[cfg(test)]
mod vendored_schema;
mod version;

/// Codex's fixed facts.
pub(super) const DESCRIPTOR: ProviderDescriptor = ProviderDescriptor {
    id: "codex",
    name: "Codex",
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
    built_in_tools: &tools::CODEX_BUILT_IN_TOOLS,
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
    // It lists its service tiers on each model of its catalog.
    output_speed_levels: None,
    // It documents no update switch; the driver runs one exact build path instead.
    process_environment: &[],
    // Carries the app-server binary's path into the launch prelude, which never interpolates it;
    // and opens the shutdown request on the lasting service's control socket, which Codex reads on
    // Windows alone.
    launch_environment_names: &["CODEX_APP_SERVER_BIN", "CODEX_DAEMON_SHUTDOWN_SOCKET"],
    // The account's own `CODEX_HOME`.
    credential_home_environment_names: &["CODEX_HOME"],
    withheld_environment_names: &[],
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
    // Codex's own limit on a skill's name.
    skill_name_max_length: Some(64),
};
