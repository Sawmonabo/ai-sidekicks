//! Whether an account's own Claude Code fetches its claude.ai connector list, read from what the
//! daemon holds for the account: the environment it composes for the account's process, that
//! process's `get_settings` reply, the account's sign-in and the person's approval of its API
//! key, as Claude Code's fetch (`ne`, b:15669889) decides it. A skip is claimed only where it
//! surely holds, so a condition the daemon cannot read leaves the read waiting for the fetch
//! instead.

use serde::Deserialize;
use serde_json::Value;
use serde_json::value::RawValue;
use sidekicks_contracts::wire::text::is_ecmascript_whitespace;
use sidekicks_platforms::PathRules;

use crate::driver::claude::account_credentials::{API_KEY_VARIABLE, OAUTH_TOKEN_VARIABLE};
use crate::driver::claude::spawn::environment::{
    CLAUDE_GATEWAY_SWITCH_VARIABLE, CLAUDE_PROVIDER_SWITCH_VARIABLES, claude_text_variable,
};

/// The variable that switches Claude Code's claude.ai connectors off.
const CONNECTORS_SWITCH_VARIABLE: &str = "ENABLE_CLAUDEAI_MCP_SERVERS";

/// The variable that starts Claude Code in safe mode, which leaves its connectors off (`Mr`,
/// b:8611562).
const SAFE_MODE_VARIABLE: &str = "CLAUDE_CODE_SAFE_MODE";

/// The variable that starts Claude Code in bare mode, which reads no claude.ai sign-in (`wr`,
/// b:8611562).
const BARE_MODE_VARIABLE: &str = "CLAUDE_CODE_SIMPLE";

/// The gateway's address and the token Claude Code signs in to it with, which with the gateway's
/// switch make its provider the gateway (`Su`, b:12043582); outside a gateway the token takes
/// precedence over a claude.ai sign-in as a key does (`U_`, b:12064753).
const GATEWAY_ADDRESS_VARIABLE: &str = "ANTHROPIC_BASE_URL";
const AUTH_TOKEN_VARIABLE: &str = "ANTHROPIC_AUTH_TOKEN";

/// The variable naming a socket Claude Code reaches the API through, which then signs in only
/// with `CLAUDE_CODE_OAUTH_TOKEN` (`tl`, b:12063921).
const UNIX_SOCKET_VARIABLE: &str = "ANTHROPIC_UNIX_SOCKET";

/// The entrypoint whose print-mode process counts its API key only once the person approved it:
/// every other client's counts it at once (`nA`, b:12068002: `UTn()&&n`; `UTn`, b:8583930, a
/// non-interactive process whose client is not `claude-vscode`; the client set at b:28701288).
const API_KEY_APPROVAL_ENTRYPOINT: &str = "claude-vscode";

/// The variable that makes Claude Code's client `github-action` ahead of any entrypoint
/// (b:28701288), read as a switch.
const GITHUB_ACTIONS_VARIABLE: &str = "GITHUB_ACTIONS";

/// The variable naming the file descriptor Claude Code reads a key from, which takes precedence
/// over the sign-in outside a remote session or a desktop app's (`tl`: `(r||S)&&!xr()`; `NZ`,
/// b:10451032).
const KEY_DESCRIPTOR_VARIABLE: &str = "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR";

/// The variable of a remote session, under which the sign-in can stand ahead of other credentials
/// (`xr`, b:12053815), read as a switch (`FS=D.bool()`, b:8981426).
const REMOTE_SESSION_VARIABLE: &str = "CLAUDE_CODE_REMOTE";

/// The variable naming the app that started Claude Code, and the apps under which, as in a remote
/// session, the sign-in can stand ahead of other credentials (`Nc`, b:9165396).
const ENTRYPOINT_VARIABLE: &str = "CLAUDE_CODE_ENTRYPOINT";
const DESKTOP_ENTRYPOINTS: [&str; 3] = ["claude-desktop", "claude-desktop-3p", "local-agent"];

/// The desktop app under which a token or a key still takes precedence over the sign-in (`j_e`,
/// b:12057984).
const THIRD_PARTY_DESKTOP_ENTRYPOINT: &str = "claude-desktop-3p";

/// The variable naming where a host hands Claude Code its credential, under which a token or a key
/// still takes precedence over the sign-in (`j_e`, b:12057984; read as text, `ft=D.str()`,
/// b:8957034).
const HOST_AUTH_VARIABLE: &str = "CLAUDE_CODE_HOST_AUTH_ENV_VAR";

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

// The members of a `get_settings` answer the fetch reads: the merged settings and each settings
// source's own, as `{ source, settings }`.
#[derive(Default, Deserialize)]
struct ConnectorFetchSettingsReply {
    #[serde(default)]
    effective: Option<Value>,
    #[serde(default)]
    sources: Option<Value>,
}

impl ClaudeConnectorFetchSettings {
    /// Reads a `get_settings` answer; an absent one, one that is no object, or a member it lacks
    /// reads as not set.
    pub(crate) fn read(reply: Option<&RawValue>) -> Self {
        let reply: ConnectorFetchSettingsReply = reply
            .and_then(|reply| serde_json::from_str(reply.get()).ok())
            .unwrap_or_default();
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
/// settings source, safe mode, another provider than Anthropic's API or a gateway, bare mode, a
/// socket with no token, or a credential that precedes the sign-in. A key's file descriptor or an
/// API key helper precedes it outside a remote session or a desktop app's (`xr`); a token, a key
/// or a helper also does under the `claude-desktop-3p` app or a host's credential variable
/// (`j_e`, whose `yI()` holds only where that variable is set as well). A set API key is such a
/// credential where [`does_api_key_need_approval`] does not hold, else only where
/// `is_api_key_approved` (`nA`, b:12068002).
pub(crate) fn skips_connector_fetch(
    environment: &[(String, String)],
    settings: &ClaudeConnectorFetchSettings,
    is_api_key_approved: bool,
) -> bool {
    let is_set = |name: &str| claude_text_variable(environment, name).is_some();
    let is_on = |name: &str| is_variable_on(environment, name);
    let is_gateway = is_on(CLAUDE_GATEWAY_SWITCH_VARIABLE)
        && is_set(GATEWAY_ADDRESS_VARIABLE)
        && is_set(AUTH_TOKEN_VARIABLE);
    let entrypoint = claude_text_variable(environment, ENTRYPOINT_VARIABLE);
    let is_remote_or_desktop = is_on(REMOTE_SESSION_VARIABLE)
        || entrypoint.is_some_and(|entrypoint| DESKTOP_ENTRYPOINTS.contains(&entrypoint));
    let does_sign_in_lead_tokens = is_remote_or_desktop
        && !is_set(HOST_AUTH_VARIABLE)
        && entrypoint != Some(THIRD_PARTY_DESKTOP_ENTRYPOINT);
    let is_api_key_counted = is_set(API_KEY_VARIABLE)
        && (is_api_key_approved || !does_api_key_need_approval(environment));
    let has_preceding_credential = !is_set(UNIX_SOCKET_VARIABLE)
        && ((!does_sign_in_lead_tokens
            && (is_set(AUTH_TOKEN_VARIABLE) || is_api_key_counted || settings.has_api_key_helper))
            || (!is_remote_or_desktop
                && (is_set(KEY_DESCRIPTOR_VARIABLE) || settings.has_api_key_helper)));
    are_connectors_switched_off(environment)
        || settings.are_connectors_disabled
        || is_claude_safe_mode(environment)
        || CLAUDE_PROVIDER_SWITCH_VARIABLES.into_iter().any(is_on)
        || is_gateway
        || is_claude_bare_mode(environment)
        || (is_set(UNIX_SOCKET_VARIABLE) && !is_set(OAUTH_TOKEN_VARIABLE))
        || has_preceding_credential
}

/// Whether the account's Claude Code, started in `environment`, counts the API key it sets only
/// once the person approved it: a key under the `claude-vscode` entrypoint, outside GitHub
/// Actions, whose client then reads the stored approval.
pub(crate) fn does_api_key_need_approval(environment: &[(String, String)]) -> bool {
    claude_text_variable(environment, API_KEY_VARIABLE).is_some()
        && !is_variable_on(environment, GITHUB_ACTIONS_VARIABLE)
        && claude_text_variable(environment, ENTRYPOINT_VARIABLE)
            == Some(API_KEY_APPROVAL_ENTRYPOINT)
}

// Whether `environment` starts Claude Code in safe mode, which fetches no connector list.
fn is_claude_safe_mode(environment: &[(String, String)]) -> bool {
    is_variable_on(environment, SAFE_MODE_VARIABLE)
}

// Whether `environment` starts Claude Code in bare mode, which reads no claude.ai sign-in.
fn is_claude_bare_mode(environment: &[(String, String)]) -> bool {
    is_variable_on(environment, BARE_MODE_VARIABLE)
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

// Whether `environment` sets the variable `name` to a value that reads as on.
fn is_variable_on(environment: &[(String, String)], name: &str) -> bool {
    PathRules::NATIVE
        .environment_value(environment, name)
        .is_some_and(is_switched_on)
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
