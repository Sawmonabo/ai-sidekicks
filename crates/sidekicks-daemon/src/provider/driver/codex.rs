//! The Codex driver, over the one shared Codex app-server every session reaches by its socket.

use sidekicks_contracts::mcp::server::config::{McpDeclaredConfigMember, McpTransport};
use sidekicks_contracts::voice::VoiceKind;
use sidekicks_platforms::SystemFolderBase;

use crate::provider::driver::{
    InstallFolder, InstallFolderBase, ManagedSettingsFolder, ManagedSettingsFolders,
    ProviderCommand, ProviderCommandLookup, ProviderDescriptor,
};

mod ask_option_sets;
mod capability_probe;
mod delivery;
mod input_limit;
mod intervention;
mod permission_level;
mod rules;
mod service;
mod tools;
mod usage_limit_signal;
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
    managed_settings_folders: ManagedSettingsFolders {
        macos: Some(ManagedSettingsFolder {
            base: SystemFolderBase::Etc,
            components: &["codex"],
        }),
        linux: Some(ManagedSettingsFolder {
            base: SystemFolderBase::Etc,
            components: &["codex"],
        }),
        windows: Some(ManagedSettingsFolder {
            base: SystemFolderBase::ProgramData,
            components: &["OpenAI", "Codex"],
        }),
    },
    // Listed first on every model that publishes a tier, and requested by clearing the thread's.
    standard_output_speed: "default",
    // It lists its service tiers on each model of its catalog.
    output_speed_levels: None,
    // It documents no update switch; the driver runs one exact build path instead.
    process_environment: &[],
    // Carries the app-server binary's path into the launch prelude, which never interpolates it.
    launch_environment_names: &["CODEX_APP_SERVER_BIN"],
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
    // Codex publishes no turn cap.
    bounds_turn_steps: false,
};
