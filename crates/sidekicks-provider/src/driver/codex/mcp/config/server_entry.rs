//! One server entry of Codex's config or a plugin's MCP file, read into its redacted declaration:
//! environment and header values are skipped as they are read, the address is stripped, and the
//! sign-in client keeps its id and callback address only.

use std::collections::BTreeMap;

use serde::Deserialize;
use serde::de::IgnoredAny;
use serde_json::Value;
use sidekicks_contracts::mcp::server::config::McpServerConfigView;
use sidekicks_contracts::wire::number::PositiveNumber;

use crate::driver::mcp_server::address::read_server_address;
use crate::driver::mcp_server::read::McpServerSignInClient;

// The members that name how a server is reached: a program for stdio, an address for HTTP.
const COMMAND_MEMBER: &str = "command";
const URL_MEMBER: &str = "url";
// The member that switches a server on or off.
const ENABLED_MEMBER: &str = "enabled";
// The header Codex sends a bearer token in.
const AUTHORIZATION_HEADER: &str = "Authorization";

/// One server entry's redacted declaration and the sign-in client it names.
pub(crate) struct CodexServerDeclaration {
    /// The declaration, every credential-bearing value reduced to its name.
    pub(crate) config: McpServerConfigView,
    /// The sign-in client the entry names, where it names one.
    pub(crate) sign_in_client: Option<McpServerSignInClient>,
}

/// Whether `entry` names how its server is reached, so it declares a server rather than overriding
/// members of one declared in a lower layer.
pub(crate) fn has_transport(entry: &Value) -> bool {
    entry.get(COMMAND_MEMBER).is_some() || entry.get(URL_MEMBER).is_some()
}

/// The switch `entry` sets for its server; `None` where it sets none.
pub(crate) fn read_switch(entry: &Value) -> Option<bool> {
    entry.get(ENABLED_MEMBER)?.as_bool()
}

/// Whether `entry` switches its server off.
pub(crate) fn is_switched_off(entry: &Value) -> bool {
    read_switch(entry) == Some(false)
}

/// Whether `entry` sets a member other than the switch, so it overrides a lower declaration.
pub(crate) fn sets_other_members(entry: &Value) -> bool {
    entry
        .as_object()
        .is_some_and(|members| members.keys().any(|member| member != ENABLED_MEMBER))
}

/// The redacted declaration of `entry`; `None` for an entry that names no transport or does not
/// read as a server entry.
pub(crate) fn read_codex_server_entry(entry: &Value) -> Option<CodexServerDeclaration> {
    let entry = CodexServerEntry::deserialize(entry).ok()?;
    let sign_in_client = entry
        .oauth
        .as_ref()
        .filter(|oauth| oauth.client_id.is_some() || oauth.callback_url.is_some())
        .map(|oauth| McpServerSignInClient {
            client_id: oauth.client_id.clone(),
            callback_url: oauth.callback_url.clone(),
        });
    let startup_timeout_sec = entry
        .startup_timeout_sec
        .or_else(|| {
            entry
                .startup_timeout_ms
                .map(|milliseconds| milliseconds / 1000.0)
        })
        .and_then(PositiveNumber::new);
    let tool_timeout_sec = entry.tool_timeout_sec.and_then(PositiveNumber::new);
    let config = if let Some(command) = entry.command {
        let mut env_var_names: Vec<String> = Vec::new();
        let declared = entry.env.iter().flat_map(BTreeMap::keys).cloned().chain(
            entry
                .env_vars
                .into_iter()
                .flatten()
                .map(CodexEnvVar::into_name),
        );
        for name in declared {
            if !env_var_names.contains(&name) {
                env_var_names.push(name);
            }
        }
        McpServerConfigView::Stdio {
            command,
            args: entry.args,
            env_var_names: (!env_var_names.is_empty()).then_some(env_var_names),
            enabled: entry.enabled,
            required: entry.required,
            startup_timeout_sec,
            tool_timeout_sec,
        }
    } else {
        let address = read_server_address(entry.url.as_deref()?);
        let mut header_names: Vec<String> = Vec::new();
        let declared = entry
            .http_headers
            .iter()
            .chain(&entry.env_http_headers)
            .flat_map(BTreeMap::keys)
            .cloned()
            .chain(
                entry
                    .bearer_token_env_var
                    .is_some()
                    .then(|| AUTHORIZATION_HEADER.to_owned()),
            );
        for name in declared {
            if !header_names.contains(&name) {
                header_names.push(name);
            }
        }
        McpServerConfigView::Http {
            url: address.stripped_url,
            url_query_param_names: (!address.query_param_names.is_empty())
                .then_some(address.query_param_names),
            header_names: (!header_names.is_empty()).then_some(header_names),
            bearer_token_env_var: None,
            env_http_headers: None,
            oauth_scopes: entry.scopes,
            oauth_resource: entry.oauth_resource,
            enabled: entry.enabled,
            required: entry.required,
            startup_timeout_sec,
            tool_timeout_sec,
        }
    };
    Some(CodexServerDeclaration {
        config,
        sign_in_client,
    })
}

// The members of a Codex server entry the read keeps. Environment and header values are skipped as
// they are read, a bearer token and the sign-in client's secret are never read, and the address is
// held only until it is stripped. It derives no `Debug`, so nothing prints the address.
#[derive(Deserialize)]
struct CodexServerEntry {
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    args: Option<Vec<String>>,
    #[serde(default)]
    env: Option<BTreeMap<String, IgnoredAny>>,
    #[serde(default)]
    env_vars: Option<Vec<CodexEnvVar>>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    http_headers: Option<BTreeMap<String, IgnoredAny>>,
    #[serde(default)]
    env_http_headers: Option<BTreeMap<String, IgnoredAny>>,
    #[serde(default)]
    bearer_token_env_var: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    required: Option<bool>,
    #[serde(default)]
    startup_timeout_sec: Option<f64>,
    #[serde(default)]
    startup_timeout_ms: Option<f64>,
    #[serde(default)]
    tool_timeout_sec: Option<f64>,
    #[serde(default)]
    scopes: Option<Vec<String>>,
    #[serde(default)]
    oauth: Option<CodexSignInClient>,
    #[serde(default)]
    oauth_resource: Option<String>,
}

// One variable a stdio server inherits: its name, or its name with where it is read.
#[derive(Deserialize)]
#[serde(untagged)]
enum CodexEnvVar {
    Name(String),
    Sourced { name: String },
}

impl CodexEnvVar {
    fn into_name(self) -> String {
        match self {
            Self::Name(name) | Self::Sourced { name } => name,
        }
    }
}

// The sign-in client's id and callback address; a plugin's file spells them in camel case.
#[derive(Deserialize)]
struct CodexSignInClient {
    #[serde(default, alias = "clientId")]
    client_id: Option<String>,
    #[serde(default, alias = "callbackUrl")]
    callback_url: Option<String>,
}
