//! The Claude Code driver.

use sidekicks_contracts::mcp::server::config::McpTransport;
use sidekicks_contracts::voice::VoiceKind;
use sidekicks_platforms::{
    LinuxSystemFolder, MacosSystemFolder, PerSystem, SystemFolder, SystemFolders,
    WindowsSystemFolder,
};

use crate::provider::driver::{
    BackgroundWork, CommandSandboxNeeds, InstallFolder, InstallFolderBase, ProviderCommand,
    ProviderCommandLookup, ProviderDescriptor, ProviderMemoryEstimates,
};

mod attachments;
mod capabilities;
mod capability_probe;
mod delivery;
mod event_normalizer;
mod frame_routing;
mod handshake_register;
mod hooks;
pub(crate) mod inbox_address;
mod output_speed;
mod run;
mod session;
mod spawn;
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
    // The account's configuration home, its credential store, and the scratch folder the daemon
    // keeps per account home, so a session's temporary files sit where its purge finds them.
    credential_home_environment_names: &[
        "CLAUDE_CONFIG_DIR",
        "CLAUDE_SECURESTORAGE_CONFIG_DIR",
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
    ],
    screen_reader_environment_names: &["CLAUDE_AX_SCREEN_READER"],
    voice_kinds: &[VoiceKind::Dictation],
    mcp_transports: &[McpTransport::Stdio, McpTransport::Http, McpTransport::Sse],
    mcp_config_members: &[],
    skill_name_max_length: None,
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
};
