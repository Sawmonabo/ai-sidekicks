//! One server entry of Codex's config or a plugin's MCP file, read into its redacted declaration:
//! environment and header values are skipped as they are read, the names of the variables a bearer
//! token and a header are read from are kept, the address is stripped, the sign-in client keeps its
//! id and callback address only, and the values it gives its tools are kept.

use std::collections::BTreeMap;

use serde::Deserialize;
use serde::de::IgnoredAny;
use serde_json::Value;
use sidekicks_contracts::mcp::server::config::McpServerConfigView;
use sidekicks_contracts::mcp::server::{McpApprovalMode, McpToolName};
use sidekicks_contracts::wire::number::PositiveNumber;
use sidekicks_contracts::wire::record::Record;

use crate::driver::mcp_server::address::read_server_address;
use crate::driver::mcp_server::read::{McpServerSignInClient, McpServerToolDefaults};

// The members that name how a server is reached: a program for stdio, an address for HTTP.
const COMMAND_MEMBER: &str = "command";
const URL_MEMBER: &str = "url";
/// The member of a server entry that switches the server on or off.
pub(crate) const ENABLED_MEMBER: &str = "enabled";
// The header Codex sends a bearer token in.
const AUTHORIZATION_HEADER: &str = "Authorization";
// The approval mode Codex gives a server's tools when its entry sets none.
const CODEX_TOOL_APPROVAL_MODE: McpApprovalMode = McpApprovalMode::Auto;

/// One server entry's redacted declaration, the sign-in client it names and the values it gives
/// its tools.
pub(crate) struct CodexServerDeclaration {
    /// The declaration, every credential-bearing value reduced to its name.
    pub(crate) config: McpServerConfigView,
    /// The sign-in client the entry names, where it names one.
    pub(crate) sign_in_client: Option<McpServerSignInClient>,
    /// The values the entry gives its tools: Codex's allow and deny lists and approval modes.
    pub(crate) tool_defaults: McpServerToolDefaults,
}

/// How an entry's server is started or reached as Codex compares it with its requirements: the
/// program and its arguments, or the address exactly as the entry writes it, its query and any
/// user name or password included. Its `Debug` prints neither, since the address may carry a
/// credential.
#[derive(Clone)]
pub(crate) enum CodexServerTransport {
    /// A program and its arguments.
    Command {
        /// The program.
        command: String,
        /// Its arguments.
        args: Vec<String>,
    },
    /// An address, as written.
    Url(String),
}

impl std::fmt::Debug for CodexServerTransport {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let kind = match self {
            Self::Command { .. } => "Command",
            Self::Url(_) => "Url",
        };
        formatter.debug_struct(kind).finish_non_exhaustive()
    }
}

/// The transport `entry` declares as Codex compares it with its requirements; `None` for an entry
/// that names none.
pub(crate) fn read_codex_server_transport(entry: &Value) -> Option<CodexServerTransport> {
    if let Some(command) = entry.get(COMMAND_MEMBER).and_then(Value::as_str) {
        let args = entry
            .get("args")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|argument| argument.as_str().map(str::to_owned))
            .collect();
        return Some(CodexServerTransport::Command {
            command: command.to_owned(),
            args,
        });
    }
    let url = entry.get(URL_MEMBER)?.as_str()?;
    Some(CodexServerTransport::Url(url.to_owned()))
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
#[expect(
    clippy::zero_sized_map_values,
    reason = "only the keys are read; each value is skipped unread so none outlives the parse"
)]
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
    let tool_defaults = McpServerToolDefaults {
        approval_mode: entry
            .default_tools_approval_mode
            .unwrap_or(CODEX_TOOL_APPROVAL_MODE),
        tool_approval_modes: entry
            .tools
            .into_iter()
            .flatten()
            .filter_map(|(name, tool)| Some((McpToolName::new(name).ok()?, tool.approval_mode?)))
            .collect(),
        enabled_tools: entry.enabled_tools.map(read_tool_names),
        disabled_tools: entry
            .disabled_tools
            .map(read_tool_names)
            .unwrap_or_default(),
    };
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
            .flat_map(BTreeMap::keys)
            .chain(entry.env_http_headers.iter().flat_map(BTreeMap::keys))
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
            bearer_token_env_var: entry.bearer_token_env_var,
            env_http_headers: entry.env_http_headers.and_then(Record::new),
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
        tool_defaults,
    })
}

// A tool list's names that pass the wire bound; Codex matches a longer one against no tool.
fn read_tool_names(names: Vec<String>) -> Vec<McpToolName> {
    names
        .into_iter()
        .filter_map(|name| McpToolName::new(name).ok())
        .collect()
}

// The members of a Codex server entry the read keeps. Environment and header values are skipped as
// they are read, a bearer token and the sign-in client's secret are never read, and the address is
// held only until it is stripped; a header read from a variable keeps the variable's name, never
// its value. It derives no `Debug`, so nothing prints the address.
#[derive(Deserialize)]
#[expect(
    clippy::zero_sized_map_values,
    reason = "only the keys are read; each value is skipped unread so none outlives the parse"
)]
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
    env_http_headers: Option<BTreeMap<String, String>>,
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
    #[serde(default)]
    default_tools_approval_mode: Option<McpApprovalMode>,
    #[serde(default)]
    enabled_tools: Option<Vec<String>>,
    #[serde(default)]
    disabled_tools: Option<Vec<String>>,
    #[serde(default)]
    tools: Option<BTreeMap<String, CodexToolEntry>>,
}

// One tool's entry under a server's `tools`: its approval mode, where it sets one.
#[derive(Deserialize)]
struct CodexToolEntry {
    #[serde(default)]
    approval_mode: Option<McpApprovalMode>,
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
