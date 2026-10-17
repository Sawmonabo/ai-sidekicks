//! The Codex driver, over the one shared Codex app-server every session reaches by its socket.

use sidekicks_contracts::mcp::server::config::{McpDeclaredConfigMember, McpTransport};
use sidekicks_contracts::voice::VoiceKind;

use crate::provider::driver::ProviderDescriptor;

mod ask_option_sets;
mod delivery;
mod input_limit;
mod intervention;
mod permission_level;
mod service;
mod tools;
mod usage_limit_signal;

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
    // Carries the app-server binary's path into the launch prelude, which never interpolates it.
    app_set_environment_names: &["CODEX_APP_SERVER_BIN"],
    screen_reader_environment_name: None,
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
