//! An organization's MCP servers for Claude Code: whether its administrator's MCP file is on this
//! computer, and the servers a Claude Code process reports from it and from the managed settings'
//! `managedMcpServers`, a remote one served with its address's host only, and each kept whole, its
//! headers or environment included, only in the form a probe sends. The file's own entries are
//! never read: the process reports each of them as an `enterprise` row, as Claude Code loads it.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Deserialize;
use serde::de::IgnoredAny;
use serde_json::Value;
use sidekicks_contracts::mcp::server::config::McpServerConfigView;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
use url::{Position, Url};

use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::mcp::config::{ClaudeMcpEndpoint, ClaudeMcpServer};
use crate::driver::claude::session::transport::control::ClaudeToolServerEntry;
use crate::driver::claude::session::transport::mcp_status::ClaudeMcpServerStatusRow;
use crate::driver::mcp_server::address::{
    ServerAddressIdentity, ServerAddressReading, read_server_address,
};

/// The administrator's MCP file, whose presence makes Claude Code exit at startup when it is told
/// to load only the servers it is given.
const CLAUDE_MANAGED_MCP_FILE: &str = "managed-mcp.json";

/// Whether Claude Code can read an administrator's MCP file in `managed_settings_folder`, the
/// folder it reads its managed settings from; `false` where the system has none. Only the file's
/// presence is checked, never its contents: a parse that disagreed with Claude Code's own would
/// fail toward the startup exit.
pub(crate) async fn has_readable_managed_mcp_file(managed_settings_folder: Option<&Path>) -> bool {
    let Some(folder) = managed_settings_folder else {
        return false;
    };
    tokio::fs::File::open(folder.join(CLAUDE_MANAGED_MCP_FILE))
        .await
        .is_ok()
}

/// An organization's servers as one account's process reports them: each one's declaration, and
/// each `managedMcpServers` entry in the form `mcp_set_servers` takes, its whole address and
/// headers or its program's environment included. It derives no `Debug`, and an entry's own
/// prints its transport alone.
pub(crate) struct ClaudeOrganizationServers {
    /// The servers, a remote one served with its address's host only.
    pub(crate) servers: Vec<ClaudeMcpServer>,
    /// Each `managedMcpServers` entry a probe can send whole, by its server's name; a server with
    /// none reads `unknown` unsent.
    pub(crate) entries: BTreeMap<McpServerName, ClaudeToolServerEntry>,
}

/// The organization's servers among `rows`, an account's `mcp_status` rows, and in
/// `effective_settings`, its `get_settings` reply's merged settings: each `managedMcpServers`
/// entry, then each `managed` or `enterprise` row of a name not yet listed, so an entry Claude
/// Code reports both ways is listed once, by the settings' whole address. Only a
/// `managedMcpServers` entry is kept in a form a probe sends: Claude Code reports a row's address
/// cut short and its headers not at all.
pub(crate) fn read_claude_organization_servers(
    rows: &[ClaudeMcpServerStatusRow],
    effective_settings: Option<&Value>,
) -> ClaudeOrganizationServers {
    let mut servers: Vec<ClaudeMcpServer> = Vec::new();
    let mut entries = BTreeMap::new();
    for (name, entry) in read_managed_server_entries(effective_settings) {
        let address = entry.url.as_deref().map(read_server_address);
        let program = entry
            .command
            .clone()
            .map(|command| (command, entry.args.clone().unwrap_or_default()));
        if let Some(server) = managed_server(name, entry.transport.as_deref(), address, program) {
            if let (McpServerBindingRef::Managed { server_name, .. }, Some(sendable)) =
                (&server.binding, compose_organization_entry(entry))
            {
                entries.insert(server_name.clone(), sendable);
            }
            push_unlisted(&mut servers, server);
        }
    }
    for row in rows {
        if !is_organization_row(row) {
            continue;
        }
        let (Some(name), Some(config)) = (row.name.as_deref(), row.config.as_ref()) else {
            continue;
        };
        let program = config
            .command
            .clone()
            .map(|command| (command, config.args.clone().unwrap_or_default()));
        let address = config.address.as_ref().map(copy_address);
        if let Some(server) = managed_server(name, config.transport.as_deref(), address, program) {
            push_unlisted(&mut servers, server);
        }
    }
    ClaudeOrganizationServers { servers, entries }
}

/// Whether `row`, an `mcp_status` row, reports one of the organization's servers: a `managed` or
/// an `enterprise` one.
pub(crate) fn is_organization_row(row: &ClaudeMcpServerStatusRow) -> bool {
    matches!(
        row.source.as_deref().or(row.scope.as_deref()),
        Some("managed" | "enterprise")
    )
}

/// The name and folded whole address of each `managedMcpServers` entry in `effective_settings`,
/// a `get_settings` reply's merged settings, that names an address that parses.
pub(crate) fn read_organization_addresses(
    effective_settings: Option<&Value>,
) -> Vec<(String, ServerAddressIdentity)> {
    read_managed_server_entries(effective_settings)
        .filter_map(|(name, entry)| {
            let identity = read_server_address(entry.url.as_deref()?).identity?;
            Some((name.clone(), identity))
        })
        .collect()
}

// Each `managedMcpServers` entry in `effective_settings` that reads as a server entry, by name.
fn read_managed_server_entries(
    effective_settings: Option<&Value>,
) -> impl Iterator<Item = (&String, ClaudeManagedServerEntry)> {
    effective_settings
        .and_then(|settings| settings.get("managedMcpServers"))
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(name, entry)| {
            Some((name, ClaudeManagedServerEntry::deserialize(entry).ok()?))
        })
}

/// The declaration of a remote server reached over `transport`, `http`, `sse` or `ws`, at `url`,
/// with the names of the query parameters stripped from it; `None` for any other transport.
pub(crate) fn remote_server_view(
    transport: &str,
    url: String,
    url_query_param_names: Option<Vec<String>>,
) -> Option<McpServerConfigView> {
    Some(match transport {
        "http" => McpServerConfigView::Http {
            url,
            url_query_param_names,
            header_names: None,
            bearer_token_env_var: None,
            env_http_headers: None,
            oauth_scopes: None,
            oauth_resource: None,
            enabled: None,
            required: None,
            startup_timeout_sec: None,
            tool_timeout_sec: None,
        },
        "sse" => McpServerConfigView::Sse {
            url,
            url_query_param_names,
            header_names: None,
            bearer_token_env_var: None,
            env_http_headers: None,
            oauth_scopes: None,
            oauth_resource: None,
            enabled: None,
            required: None,
            startup_timeout_sec: None,
            tool_timeout_sec: None,
        },
        "ws" => McpServerConfigView::Ws {
            url,
            url_query_param_names,
            header_names: None,
        },
        _ => return None,
    })
}

// An entry of `managedMcpServers`, which takes the `.mcp.json` server shape (b:4021340): its
// transport, its program, arguments and environment or its address and headers, values included,
// and whether it fetches its headers from a program or signs in itself. It derives no `Debug`, so
// nothing prints a value.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeManagedServerEntry {
    #[serde(rename = "type", default)]
    transport: Option<String>,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    args: Option<Vec<String>>,
    #[serde(default)]
    env: Option<Value>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    headers: Option<Value>,
    #[serde(default)]
    headers_helper: Option<IgnoredAny>,
    #[serde(default)]
    oauth: Option<IgnoredAny>,
}

// A `managedMcpServers` entry as `mcp_set_servers` takes it; `None` for a program with no command
// or a remote server with no address, a transport the set has no form for, an environment or
// headers that are not all text, or one that fetches its headers or signs in itself, none of which
// a probe could send whole.
fn compose_organization_entry(entry: ClaudeManagedServerEntry) -> Option<ClaudeToolServerEntry> {
    if entry.headers_helper.is_some() || entry.oauth.is_some() {
        return None;
    }
    let text_map = |map: Option<Value>| -> Option<BTreeMap<String, String>> {
        map.map_or(Some(BTreeMap::new()), |map| {
            serde_json::from_value(map).ok()
        })
    };
    match entry.transport.as_deref() {
        None | Some("stdio") => Some(ClaudeToolServerEntry::Stdio {
            command: entry.command?,
            args: entry.args.unwrap_or_default(),
            env: text_map(entry.env)?,
        }),
        Some("http") => Some(ClaudeToolServerEntry::Http {
            url: entry.url?,
            headers: text_map(entry.headers)?,
        }),
        Some("sse") => Some(ClaudeToolServerEntry::Sse {
            url: entry.url?,
            headers: text_map(entry.headers)?,
        }),
        Some(_) => None,
    }
}

// One organization server named `name`: a remote one served with its address's host alone, a
// program with its command and arguments. `None` for a name that is no server name, or a
// transport with no declaration form.
fn managed_server(
    name: &str,
    transport: Option<&str>,
    address: Option<ServerAddressReading>,
    program: Option<(String, Vec<String>)>,
) -> Option<ClaudeMcpServer> {
    let server_name = McpServerName::new(name.to_owned()).ok()?;
    let (config, endpoint) = match (transport, address, program) {
        (Some(transport @ ("http" | "sse" | "ws")), Some(address), _) => (
            remote_server_view(transport, address_host(&address.stripped_url), None)?,
            address.identity.map(ClaudeMcpEndpoint::Address),
        ),
        (None | Some("stdio"), _, Some((command, args))) => (
            McpServerConfigView::Stdio {
                command: command.clone(),
                args: Some(args.clone()),
                env_var_names: None,
                enabled: None,
                required: None,
                startup_timeout_sec: None,
                tool_timeout_sec: None,
            },
            Some(ClaudeMcpEndpoint::Command { command, args }),
        ),
        _ => return None,
    };
    Some(ClaudeMcpServer {
        binding: McpServerBindingRef::Managed {
            provider: DESCRIPTOR.provider_id(),
            server_name,
        },
        config,
        endpoint,
        organization_managed: None,
    })
}

// The host of a stripped address, with its port where it names one; empty where the address does
// not parse, as one holding a `${VAR}` host does.
fn address_host(stripped_url: &str) -> String {
    Url::parse(stripped_url)
        .ok()
        .filter(Url::has_host)
        .map(|url| url[Position::BeforeHost..Position::AfterPort].to_owned())
        .unwrap_or_default()
}

// A row's address, copied so the server built from it owns it.
fn copy_address(address: &ServerAddressReading) -> ServerAddressReading {
    ServerAddressReading {
        stripped_url: address.stripped_url.clone(),
        query_param_names: address.query_param_names.clone(),
        identity: address.identity.clone(),
    }
}

fn push_unlisted(servers: &mut Vec<ClaudeMcpServer>, server: ClaudeMcpServer) {
    if !servers
        .iter()
        .any(|listed| listed.binding == server.binding)
    {
        servers.push(server);
    }
}

#[cfg(test)]
mod tests {
    use super::{CLAUDE_MANAGED_MCP_FILE, has_readable_managed_mcp_file};

    // The check reads the folder it is handed: a test folder with the file and one without.
    // Killed by a check that reads a fixed path, which finds the file in neither.
    #[tokio::test]
    async fn the_managed_mcp_file_is_found_at_the_folder_handed_in() {
        let with_file = tempfile::tempdir().expect("a test folder");
        let without_file = tempfile::tempdir().expect("a test folder");
        tokio::fs::write(with_file.path().join(CLAUDE_MANAGED_MCP_FILE), "{}")
            .await
            .expect("the file is written");

        assert!(has_readable_managed_mcp_file(Some(with_file.path())).await);
        assert!(!has_readable_managed_mcp_file(Some(without_file.path())).await);
        assert!(!has_readable_managed_mcp_file(None).await);
    }
}
