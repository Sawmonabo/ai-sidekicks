//! The Claude Code driver.

use sidekicks_contracts::mcp::server::config::McpTransport;
use sidekicks_contracts::voice::VoiceKind;
use sidekicks_platforms::SystemFolderBase;

use crate::provider::driver::{
    InstallFolder, InstallFolderBase, ManagedSettingsFolder, ManagedSettingsFolders,
    ProviderCommand, ProviderCommandLookup, ProviderDescriptor,
};

mod capability_probe;
mod delivery;
mod event_normalizer;
mod hooks;
mod run;
mod session;
mod spent_retries_signal;
mod tools;
mod turn_evidence;
mod version;

/// Claude Code's fixed facts. Its plan ids read as their own words, and it reads no tool-server
/// declaration member beyond the shared ones.
pub(super) const DESCRIPTOR: ProviderDescriptor = ProviderDescriptor {
    id: "claude",
    name: "Claude Code",
    plan_words: &[],
    built_in_tools: &tools::CLAUDE_BUILT_IN_TOOLS,
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
    managed_settings_folders: ManagedSettingsFolders {
        macos: Some(ManagedSettingsFolder {
            base: SystemFolderBase::ApplicationSupport,
            components: &["ClaudeCode"],
        }),
        linux: Some(ManagedSettingsFolder {
            base: SystemFolderBase::Etc,
            components: &["claude-code"],
        }),
        windows: Some(ManagedSettingsFolder {
            base: SystemFolderBase::ProgramFiles,
            components: &["ClaudeCode"],
        }),
    },
    standard_output_speed: "off",
    // Its declared state has a third value, which the provider enters after a rate limit and no
    // request asks for.
    output_speed_levels: Some(&["off", "on"]),
    process_environment: &[
        // Its two update switches, so the build recorded at start is the one that runs.
        ("DISABLE_AUTOUPDATER", "1"),
        ("DISABLE_UPDATES", "1"),
        // A tool-server call or a helper still running after 120 s moves to the background.
        ("CLAUDE_AUTO_BACKGROUND_TASKS", "1"),
        // A waiting dialog arms no deadline.
        ("CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS", "0"),
        // A background command's `timeout` is honored up to Claude Code's own cap.
        ("BASH_MAX_TIMEOUT_MS", "2147483647"),
    ],
    launch_environment_names: &[],
    // The account's configuration home and its credential store.
    credential_home_environment_names: &["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"],
    withheld_environment_names: &[
        // Forces the permission mode to `default`.
        "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
        // Ends a process that holds a pending wake-up.
        "CLAUDE_CODE_EXIT_AFTER_STOP_DELAY",
        // Hands a flagged removal to the auto-mode classifier.
        "CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT",
        // Joins the per-session memories the daemon keeps apart.
        "CLAUDE_CODE_REMOTE_MEMORY_DIR",
    ],
    screen_reader_environment_names: &["CLAUDE_AX_SCREEN_READER"],
    voice_kinds: &[VoiceKind::Dictation],
    mcp_transports: &[McpTransport::Stdio, McpTransport::Http, McpTransport::Sse],
    mcp_config_members: &[],
    skill_name_max_length: None,
};
