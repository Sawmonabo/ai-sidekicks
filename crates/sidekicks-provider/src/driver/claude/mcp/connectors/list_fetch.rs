//! Whether an account's own Claude Code fetches its claude.ai connector list, read from what the
//! daemon holds for the account: the environment it composes for the account's process, that
//! process's `get_settings` reply and the account's sign-in, as Claude Code's fetch (`ne`,
//! b:15669889) decides it. A skip is claimed only where it surely holds, so a condition the daemon
//! cannot read leaves the read waiting for the fetch instead.

use serde_json::Value;
use sidekicks_contracts::wire::text::is_ecmascript_whitespace;
use sidekicks_platforms::PathRules;

use crate::driver::claude::session::transport::control::ClaudeSettingsReply;

/// The variable that switches Claude Code's claude.ai connectors off.
const CONNECTORS_SWITCH_VARIABLE: &str = "ENABLE_CLAUDEAI_MCP_SERVERS";

/// The variable that starts Claude Code in safe mode, which leaves its connectors off (`Mr`,
/// b:8611562).
const SAFE_MODE_VARIABLE: &str = "CLAUDE_CODE_SAFE_MODE";

/// The variable that starts Claude Code in bare mode, which reads no claude.ai sign-in (`wr`,
/// b:8611562).
const BARE_MODE_VARIABLE: &str = "CLAUDE_CODE_SIMPLE";

/// The variables that each move Claude Code to a provider other than Anthropic's own API (`Ae`,
/// b:9648677).
const THIRD_PARTY_PROVIDER_VARIABLES: [&str; 6] = [
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_USE_VERTEX",
];

/// The variable naming a socket Claude Code reaches the API through, which then signs in only
/// with `CLAUDE_CODE_OAUTH_TOKEN` (`tl`, b:12063921).
const UNIX_SOCKET_VARIABLE: &str = "ANTHROPIC_UNIX_SOCKET";

/// The variable whose token Claude Code signs in with ahead of its stored sign-in (`Ln`,
/// b:12097863).
pub(crate) const OAUTH_TOKEN_VARIABLE: &str = "CLAUDE_CODE_OAUTH_TOKEN";

/// The variables whose credential takes precedence over a claude.ai sign-in in a print-mode
/// process (`tl`, b:12063921; `nA`, b:12068002).
const PRECEDING_CREDENTIAL_VARIABLES: [&str; 2] = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"];

/// The variable of a remote session, where those credentials can stand aside for the sign-in
/// (`xr`, b:12053815; `j_e`, b:12058162).
const REMOTE_SESSION_VARIABLE: &str = "CLAUDE_CODE_REMOTE";

/// The scopes a sign-in needs for Claude Code to fetch the list: inference, without which a
/// credential is taken to precede it (`Et`, b:12115433), and the list's own.
const FETCH_SCOPES: [&str; 2] = ["user:inference", "user:mcp_servers"];

/// What in an account's `get_settings` reply bears on its connector fetch: whether any settings
/// source switches the connectors off (`afe`, b:10067964), and whether the merged settings name an
/// API key helper, which precedes the sign-in (`Ng`, b:12069425).
pub(crate) struct ClaudeConnectorFetchSettings {
    are_connectors_disabled: bool,
    has_api_key_helper: bool,
}

impl ClaudeConnectorFetchSettings {
    /// Reads `reply`; a member it lacks reads as not set.
    pub(crate) fn read(reply: &ClaudeSettingsReply) -> Self {
        let are_connectors_disabled = reply
            .sources
            .as_ref()
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|source| source.get("settings")?.get("disableClaudeAiConnectors"))
            .any(|disabled| *disabled == Value::Bool(true));
        let has_api_key_helper = reply
            .effective
            .as_ref()
            .and_then(|settings| settings.get("apiKeyHelper")?.as_str())
            .is_some_and(|helper| !helper.is_empty());
        Self {
            are_connectors_disabled,
            has_api_key_helper,
        }
    }
}

/// Whether the account's Claude Code, started in `environment` with `settings`, skips its fetch
/// of the connector list whatever its sign-in: its connectors switched off by the variable or a
/// settings source, safe mode, another provider than Anthropic's API, bare mode, a socket with no
/// token, or a credential that precedes the sign-in outside a remote session.
pub(crate) fn skips_connector_fetch(
    environment: &[(String, String)],
    settings: &ClaudeConnectorFetchSettings,
) -> bool {
    let value = |name: &str| PathRules::NATIVE.environment_value(environment, name);
    let is_set = |name: &str| value(name).is_some_and(|value| !value.is_empty());
    let is_on = |name: &str| value(name).is_some_and(is_switched_on);
    let has_preceding_credential = !is_set(UNIX_SOCKET_VARIABLE)
        && !is_set(REMOTE_SESSION_VARIABLE)
        && (PRECEDING_CREDENTIAL_VARIABLES.into_iter().any(is_set) || settings.has_api_key_helper);
    are_connectors_switched_off(environment)
        || settings.are_connectors_disabled
        || is_on(SAFE_MODE_VARIABLE)
        || THIRD_PARTY_PROVIDER_VARIABLES.into_iter().any(is_on)
        || is_on(BARE_MODE_VARIABLE)
        || (is_set(UNIX_SOCKET_VARIABLE) && !is_set(OAUTH_TOKEN_VARIABLE))
        || has_preceding_credential
}

/// Whether a stored sign-in granted `scopes` leaves Claude Code fetching nothing: one without
/// inference or without the list's scope.
pub(crate) fn skips_fetch_for_scopes(scopes: &[String]) -> bool {
    !FETCH_SCOPES
        .iter()
        .all(|needed| scopes.iter().any(|scope| scope == needed))
}

// Whether `environment` switches Claude Code's claude.ai connectors off, as its `is` reads
// `ENABLE_CLAUDEAI_MCP_SERVERS` (b:8444642): `0`, `false`, `no` or `off`, trimmed and in any case.
fn are_connectors_switched_off(environment: &[(String, String)]) -> bool {
    PathRules::NATIVE
        .environment_value(environment, CONNECTORS_SWITCH_VARIABLE)
        .is_some_and(|value| matches!(fold_switch(value).as_str(), "0" | "false" | "no" | "off"))
}

// Whether a variable's `value` reads as on, as Claude Code's `Ne` reads it (b:8444500): `1`,
// `true`, `yes` or `on`, trimmed and in any case.
fn is_switched_on(value: &str) -> bool {
    matches!(fold_switch(value).as_str(), "1" | "true" | "yes" | "on")
}

// A switch's value as Claude Code compares it: trimmed of ECMAScript white space, lower-cased.
fn fold_switch(value: &str) -> String {
    value.trim_matches(is_ecmascript_whitespace).to_lowercase()
}
