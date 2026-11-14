//! An organization's MCP servers for Claude Code: whether its administrator's MCP file is on this
//! computer and the entries it declares, and the servers a Claude Code process reports from it and
//! from the managed settings' `managedMcpServers`, a remote one served with its address's host
//! only. A `managedMcpServers` entry is always a remote one, since Claude Code drops one that names
//! a program, and is kept whole as written, its headers included, for a probe and a sign-in.
//! Where the file and the managed settings both declare a name, Claude Code loads the file's
//! entry, so one reader answers that entry for the listing, the probe and the sign-in alike.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Deserialize;
use serde_json::{Map, Value};
use sidekicks_contracts::mcp::server::config::McpServerConfigView;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
use url::{Position, Url};

use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::mcp::config::{
    ClaudeMcpEndpoint, ClaudeMcpServer, ClaudeOAuthMember, MCP_SERVERS_MEMBER, read_json_file,
};
use crate::driver::claude::mcp::machine_probe::variables::expand_remote_address;
use crate::driver::claude::session::transport::mcp_status::ClaudeMcpServerStatusRow;
use crate::driver::mcp_server::address::{
    ServerAddressIdentity, ServerAddressReading, read_server_address,
};

/// The administrator's MCP file, whose entries a sign-in reads for its server's address and its
/// takeover, and whose presence makes Claude Code exit at startup when it is told to load only the
/// servers it is given or, on a workstation, is handed servers with `--mcp-config`.
const CLAUDE_MANAGED_MCP_FILE: &str = "managed-mcp.json";

/// The managed setting holding the organization's server entries by name.
pub(crate) const MANAGED_MCP_SERVERS_SETTING: &str = "managedMcpServers";

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

/// The servers of the administrator's MCP file in `managed_settings_folder`, by name, each entry as
/// the administrator wrote it with its `${VAR}` unfilled, for any reader of the file's servers:
/// `None` where Claude Code can read no such file, and no servers where the file does not parse,
/// does not read once opened, as a folder of its name does, or lists none, since it is still
/// deployed. A file that does not read is logged once per daemon life.
pub(crate) async fn read_managed_mcp_servers(
    managed_settings_folder: Option<&Path>,
) -> Option<Map<String, Value>> {
    static IS_UNREAD_FILE_LOGGED: AtomicBool = AtomicBool::new(false);
    let folder = managed_settings_folder?;
    if !has_readable_managed_mcp_file(Some(folder)).await {
        return None;
    }
    let file: Option<Map<String, Value>> = match read_json_file(
        &folder.join(CLAUDE_MANAGED_MCP_FILE),
    )
    .await
    {
        Ok(file) => file,
        Err(error) => {
            if !IS_UNREAD_FILE_LOGGED.swap(true, Ordering::Relaxed) {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "the administrator's MCP file did not read; it is read as listing no servers"
                );
            }
            None
        }
    };
    let servers = match file.and_then(|mut file| file.remove(MCP_SERVERS_MEMBER)) {
        Some(Value::Object(servers)) => servers,
        Some(
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) | Value::Array(_),
        )
        | None => Map::new(),
    };
    Some(servers)
}

/// The entry of the organization's server `server_name` as Claude Code loads it: the one
/// `file_servers`, the administrator's MCP file's servers, declares by that name, else the one
/// `organization_entries` answers, an account's `managedMcpServers` entry, which is awaited only
/// where the file does not declare the name. A file entry of no object form reads as none. Fails
/// as `organization_entries` fails.
pub(crate) async fn read_managed_entry<E>(
    file_servers: Option<&Map<String, Value>>,
    server_name: &McpServerName,
    organization_entries: impl Future<Output = Result<Option<Map<String, Value>>, E>>,
) -> Result<Option<Map<String, Value>>, E> {
    match file_servers.and_then(|servers| servers.get(server_name.as_str())) {
        Some(Value::Object(entry)) => Ok(Some(entry.clone())),
        Some(
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) | Value::Array(_),
        ) => Ok(None),
        None => organization_entries.await,
    }
}

/// Lists each organization server among `servers` from its entry as [`read_managed_entry`]
/// answers it from `file_servers` and `organization_entries`, whole: its transport, its address
/// with its `${VAR}` filled from `environment`, as Claude Code fills it, its program and its
/// `oauth`. A server with no entry, or one of no form a declaration reads, stays as listed.
pub(crate) async fn take_managed_entries(
    servers: &mut [ClaudeMcpServer],
    file_servers: Option<&Map<String, Value>>,
    organization_entries: &BTreeMap<McpServerName, Map<String, Value>>,
    environment: &[(String, String)],
) {
    for server in servers {
        let McpServerBindingRef::Managed { server_name, .. } = &server.binding else {
            continue;
        };
        let organization_entry = std::future::ready(Ok::<_, std::convert::Infallible>(
            organization_entries.get(server_name).cloned(),
        ));
        let Ok(Some(entry)) =
            read_managed_entry(file_servers, server_name, organization_entry).await
        else {
            continue;
        };
        let Ok(entry) = ClaudeManagedServerEntry::deserialize(Value::Object(entry)) else {
            continue;
        };
        let address = entry
            .url
            .as_deref()
            .map(|url| read_server_address(&expand_remote_address(url, environment)));
        let program = entry
            .command
            .map(|command| (command, entry.args.unwrap_or_default()));
        if let Some(entry_server) = managed_server(
            server_name.as_str(),
            entry.transport.as_deref(),
            address,
            program,
            Some(&entry.oauth),
        ) {
            *server = entry_server;
        }
    }
}

/// An organization's servers as one account's process reports them: each one's declaration, and
/// each `managedMcpServers` entry as written, its whole address, headers and `oauth` included. It
/// derives no `Debug`, so no entry's values print.
pub(crate) struct ClaudeOrganizationServers {
    /// The servers, a remote one served with its address's host only.
    pub(crate) servers: Vec<ClaudeMcpServer>,
    /// Each `managedMcpServers` entry as written, by its server's name.
    pub(crate) entries: BTreeMap<McpServerName, Map<String, Value>>,
}

/// The organization's servers among `rows`, an account's `mcp_status` rows, and in
/// `effective_settings`, its `get_settings` reply's merged settings: each `managedMcpServers`
/// entry, then each `managed` or `enterprise` row of a name not yet listed, so an entry Claude
/// Code reports both ways is listed once, by the settings' whole address. Only a
/// `managedMcpServers` entry is kept as written: Claude Code reports a row's address cut short and
/// its headers not at all.
pub(crate) fn read_claude_organization_servers(
    rows: &[ClaudeMcpServerStatusRow],
    effective_settings: Option<&Value>,
) -> ClaudeOrganizationServers {
    let mut servers: Vec<ClaudeMcpServer> = Vec::new();
    let mut entries = BTreeMap::new();
    for (name, written, entry) in read_managed_server_entries(effective_settings) {
        let address = entry.url.as_deref().map(read_server_address);
        if let Some(server) = managed_server(
            name,
            entry.transport.as_deref(),
            address,
            None,
            Some(&entry.oauth),
        ) {
            if let (McpServerBindingRef::Managed { server_name, .. }, Some(written)) =
                (&server.binding, written.as_object())
            {
                entries.insert(server_name.clone(), written.clone());
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
        // A row reports no `oauth`, so it names no sign-in settings of its own.
        if let Some(server) =
            managed_server(name, config.transport.as_deref(), address, program, None)
        {
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
        .filter_map(|(name, _, entry)| {
            let identity = read_server_address(entry.url.as_deref()?).identity?;
            Some((name.clone(), identity))
        })
        .collect()
}

// Each `managedMcpServers` entry in `effective_settings` that reads as a server entry, by name,
// with the entry as written.
fn read_managed_server_entries(
    effective_settings: Option<&Value>,
) -> impl Iterator<Item = (&String, &Value, ClaudeManagedServerEntry)> {
    effective_settings
        .and_then(|settings| settings.get(MANAGED_MCP_SERVERS_SETTING))
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(name, entry)| {
            Some((
                name,
                entry,
                ClaudeManagedServerEntry::deserialize(entry).ok()?,
            ))
        })
}

/// The declaration of a remote server reached over `transport`, `http`, `sse` or `ws`, at `url`,
/// with the names of the query parameters stripped from it and, for `http` and `sse`, the
/// `oauth_scopes` its entry asks for; `None` for any other transport.
pub(crate) fn remote_server_view(
    transport: &str,
    url: String,
    url_query_param_names: Option<Vec<String>>,
    oauth_scopes: Option<Vec<String>>,
) -> Option<McpServerConfigView> {
    Some(match transport {
        "http" => McpServerConfigView::Http {
            url,
            url_query_param_names,
            header_names: None,
            bearer_token_env_var: None,
            env_http_headers: None,
            oauth_scopes,
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
            oauth_scopes,
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

// An organization's server entry as a listing reads it: a `managedMcpServers` entry as
// `get_settings` reports it, where Claude Code keeps only an `http` or `sse` entry at an `https:`
// address that names no program, no environment and no headers program, so its transport, its
// address and its `oauth` are all it carries; or an entry of the administrator's MCP file, which
// may also name a program.
#[derive(Deserialize)]
struct ClaudeManagedServerEntry {
    #[serde(rename = "type", default)]
    transport: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    args: Option<Vec<String>>,
    #[serde(default)]
    oauth: ClaudeOAuthMember,
}

// One organization server named `name`: a remote one served with its address's host alone and
// the sign-in settings and scopes `oauth` names, none where it is `None` as a row's is, or a
// program with its command and arguments. `None` for a name that is no server name, or a
// transport with no declaration form.
fn managed_server(
    name: &str,
    transport: Option<&str>,
    address: Option<ServerAddressReading>,
    program: Option<(String, Vec<String>)>,
    oauth: Option<&ClaudeOAuthMember>,
) -> Option<ClaudeMcpServer> {
    let server_name = McpServerName::new(name.to_owned()).ok()?;
    let (config, endpoint, sign_in_settings) = match (transport, address, program) {
        (Some("ws"), Some(address), _) => (
            remote_server_view("ws", address_host(&address.stripped_url), None, None)?,
            address.identity.map(ClaudeMcpEndpoint::Address),
            None,
        ),
        (Some(transport @ ("http" | "sse")), Some(address), _) => {
            let (sign_in_settings, oauth_scopes) =
                oauth.map(ClaudeOAuthMember::read_sign_in).unzip();
            (
                remote_server_view(
                    transport,
                    address_host(&address.stripped_url),
                    None,
                    oauth_scopes.flatten(),
                )?,
                address.identity.map(ClaudeMcpEndpoint::Address),
                sign_in_settings,
            )
        }
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
            None,
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
        sign_in_settings,
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
    use std::convert::Infallible;
    use std::future::ready;

    use rstest::rstest;
    use serde_json::{Map, Value, json};
    use sidekicks_contracts::mcp::server::McpServerName;
    use sidekicks_contracts::mcp::server::config::McpServerConfigView;

    use super::{
        CLAUDE_MANAGED_MCP_FILE, has_readable_managed_mcp_file, read_claude_organization_servers,
        read_managed_entry, read_managed_mcp_servers, take_managed_entries,
    };

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

    // An entry of the file as the administrator writes it, a variable in its address.
    fn docs_entry() -> Value {
        json!({"type": "http", "url": "https://${HOST:-docs.example.test}/mcp"})
    }

    // The file's servers are read as written where it is deployed, none where it does not parse or
    // read, and no file where there is none. Killed by the file not read, by another member read,
    // by an unparsed file read as absent, and by an unreadable one failing the read.
    #[rstest]
    #[case::deployed(
        Some(json!({"mcpServers": {"docs": docs_entry()}}).to_string()),
        Some(json!({"docs": docs_entry()}))
    )]
    #[case::unparsed(Some("not JSON".to_owned()), Some(json!({})))]
    #[case::unreadable(Some(String::new()), Some(json!({})))]
    #[case::absent(None, None)]
    #[tokio::test]
    async fn the_managed_file_servers_are_read_where_it_is_deployed(
        #[case] contents: Option<String>,
        #[case] expected: Option<Value>,
    ) {
        let folder = tempfile::tempdir().expect("a test folder");
        // An empty text stands for a folder of the file's name, which opens and does not read.
        match contents.as_deref() {
            Some("") => tokio::fs::create_dir(folder.path().join(CLAUDE_MANAGED_MCP_FILE))
                .await
                .expect("the folder is made"),
            Some(contents) => {
                tokio::fs::write(folder.path().join(CLAUDE_MANAGED_MCP_FILE), contents)
                    .await
                    .expect("the file is written");
            }
            None => {}
        }

        let read = read_managed_mcp_servers(Some(folder.path())).await;

        assert_eq!(read.map(Value::Object), expected);
    }

    // A name the administrator's MCP file and the managed settings both declare reads as the
    // file's entry, whole, without the organization's entry asked for, and lists from it with its
    // address's `${VAR}` filled from the environment; a name only the managed settings declare
    // reads as theirs. Killed by the organization's entry read first, by only `oauth` taken from
    // the file, and by the file's address listed unfilled (its host then reads empty).
    #[rstest]
    #[case::the_default(&[], "docs.example.test")]
    #[case::the_value(&[("HOST", "tenant.example.test")], "tenant.example.test")]
    #[tokio::test]
    async fn a_name_both_declare_reads_and_lists_the_files_entry_whole(
        #[case] environment: &[(&str, &str)],
        #[case] expected_host: &str,
    ) {
        let settings = json!({ "managedMcpServers": {
            "docs": {
                "type": "http",
                "url": "https://org.example.test/mcp",
                "oauth": { "clientId": "org-client" },
            },
            "wiki": { "type": "http", "url": "https://wiki.example.test/mcp" },
        } });
        let mut organization = read_claude_organization_servers(&[], Some(&settings));
        let Value::Object(file_servers) = json!({ "docs": {
            "type": "http",
            "url": "https://${HOST:-docs.example.test}/mcp",
            "oauth": { "clientId": "file-client" },
        } }) else {
            unreachable!("an object");
        };
        let environment: Vec<(String, String)> = environment
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect();
        let name = |name: &str| McpServerName::new(name.to_owned()).expect("a server name");
        // An organization entry asked for fails the read.
        let unasked = async { Err::<Option<Map<String, Value>>, _>("the organization was asked") };

        let read = read_managed_entry(Some(&file_servers), &name("docs"), unasked).await;
        let wiki: Result<_, Infallible> = read_managed_entry(
            Some(&file_servers),
            &name("wiki"),
            ready(Ok(organization.entries.get(&name("wiki")).cloned())),
        )
        .await;
        take_managed_entries(
            &mut organization.servers,
            Some(&file_servers),
            &organization.entries,
            &environment,
        )
        .await;

        assert_eq!(
            read.map(|entry| entry.map(Value::Object)),
            Ok(file_servers.get("docs").cloned())
        );
        assert_eq!(
            wiki.ok().flatten().map(Value::Object),
            Some(settings["managedMcpServers"]["wiki"].clone())
        );
        let docs = organization
            .servers
            .iter()
            .find(|server| server.binding.server_name() == &name("docs"))
            .expect("the file's server lists");
        let McpServerConfigView::Http { url, .. } = &docs.config else {
            panic!("an http server: {:?}", docs.config);
        };
        assert_eq!(url, expected_host);
        assert_eq!(
            docs.sign_in_settings
                .as_ref()
                .and_then(|settings| settings.client_id.as_deref()),
            Some("file-client")
        );
    }
}
