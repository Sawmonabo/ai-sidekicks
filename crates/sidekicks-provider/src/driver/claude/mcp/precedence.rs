//! Claude Code's precedence over the servers its config, its plugins and an account declare: which
//! server takes another's place at each attached root, and what a root's sessions load by Claude
//! Code's own config.

use std::collections::BTreeMap;

use sidekicks_contracts::mcp::server::inventory::McpOverrideOrigin;
use sidekicks_contracts::mcp::server::{McpApprovalMode, McpServerBindingRef, McpServerName};
use sidekicks_contracts::place::PlacedPath;
use sidekicks_contracts::provider::account::record::ProviderAccountId;

use crate::driver::claude::mcp::config::{ClaudeMcpConfigReading, ClaudeMcpServer};
use crate::driver::claude::session::transport::control::ClaudeToolServerEntry;
use crate::driver::mcp_server::read::{
    McpAccountServers, McpProbeReading, McpRootReading, McpServerDeclaration, McpServerToolDefaults,
};

/// The approval mode a server's tools read with no override: Claude Code asks before a tool call
/// none of its permission rules allows, and has no per-server or per-tool approval setting.
const CLAUDE_TOOL_APPROVAL_MODE: McpApprovalMode = McpApprovalMode::Prompt;

/// The servers one account brings: its organization's servers and its connectors, with what the
/// account's own process reported of each connector and each organization server a probe can send.
/// It derives no `Debug`, since an organization entry carries its headers' values.
#[derive(Clone)]
pub(crate) struct ClaudeMcpAccountServers {
    /// The account.
    pub(crate) provider_account_id: ProviderAccountId,
    /// Its organization's servers.
    pub(crate) organization_servers: Vec<ClaudeMcpServer>,
    /// Its connectors.
    pub(crate) connectors: Vec<ClaudeMcpServer>,
    /// What the account's process reported of each connector: its status, error text and tools.
    pub(crate) connector_readings: Vec<McpProbeReading>,
    /// Each organization server as `mcp_set_servers` takes it, by its name, where the account's
    /// managed settings declare it whole.
    pub(crate) organization_entries: BTreeMap<McpServerName, ClaudeToolServerEntry>,
}

/// The servers one root's sessions would see from each source, which Claude Code ranks in this
/// order, and the names switched off or kept out there.
pub(crate) struct ClaudeMcpRootSources<'servers> {
    /// The organization's servers, above every scope.
    pub(crate) organization: &'servers [ClaudeMcpServer],
    /// The `local` servers.
    pub(crate) local: &'servers [ClaudeMcpServer],
    /// The `project` servers.
    pub(crate) project: &'servers [ClaudeMcpServer],
    /// The `user` servers.
    pub(crate) user: &'servers [ClaudeMcpServer],
    /// The plugins' servers.
    pub(crate) plugin: &'servers [ClaudeMcpServer],
    /// The connectors.
    pub(crate) connector: &'servers [ClaudeMcpServer],
    /// The names Claude Code's per-project switch turns off.
    pub(crate) switched_off_server_names: &'servers [McpServerName],
    /// The names of `project` servers the root refuses.
    pub(crate) kept_out_server_names: &'servers [McpServerName],
}

/// The read's declarations, its roots and each account's servers, after Claude Code's precedence.
#[derive(Debug)]
pub(crate) struct ClaudeMcpRanking {
    /// The `user`, plugin, `local` and `project` declarations.
    pub(crate) declarations: Vec<McpServerDeclaration>,
    /// What each root keeps out and loads by Claude Code's own config.
    pub(crate) roots: Vec<McpRootReading>,
    /// Each account's organization servers and connectors.
    pub(crate) account_servers: Vec<McpAccountServers>,
}

/// Applies Claude Code's precedence to `reading` under each of `accounts`, the organization
/// servers and connectors the account read hands in, and names what each root loads by Claude
/// Code's own config: nothing, since sessions start with the person's files left out, unless
/// `has_managed_mcp_file`, where Claude Code loads only the organization's servers.
pub(crate) fn rank_claude_mcp_servers(
    reading: &ClaudeMcpConfigReading,
    accounts: &[ClaudeMcpAccountServers],
    has_managed_mcp_file: bool,
) -> ClaudeMcpRanking {
    let account_sources: Vec<(&[ClaudeMcpServer], &[ClaudeMcpServer])> = if accounts.is_empty() {
        vec![(&[], &[])]
    } else {
        accounts
            .iter()
            .map(|account| {
                (
                    account.organization_servers.as_slice(),
                    account.connectors.as_slice(),
                )
            })
            .collect()
    };
    let mut superseded: Vec<(&McpServerBindingRef, &PlacedPath)> = Vec::new();
    for root in &reading.roots {
        for (organization, connector) in &account_sources {
            let sources = ClaudeMcpRootSources {
                organization,
                local: &root.local_servers,
                project: &root.project_servers,
                user: &reading.user_servers,
                plugin: &reading.plugin_servers,
                connector,
                switched_off_server_names: &root.switched_off_server_names,
                kept_out_server_names: &root.kept_out_server_names,
            };
            for server in find_superseded_claude_mcp_servers(&sources) {
                let entry = (&server.binding, &root.root);
                if !superseded.contains(&entry) {
                    superseded.push(entry);
                }
            }
        }
    }
    let declare = |server: &ClaudeMcpServer| McpServerDeclaration {
        binding: server.binding.clone(),
        config: server.config.clone(),
        superseded_in: superseded
            .iter()
            .filter(|(binding, _root)| **binding == server.binding)
            .map(|(_binding, root)| McpOverrideOrigin::Placed((*root).clone()))
            .collect(),
        disabled_in: reading
            .roots
            .iter()
            .filter(|root| {
                is_declared_at(&server.binding, &root.root)
                    && is_switched_off(&server.binding, &root.switched_off_server_names)
            })
            .map(|root| McpOverrideOrigin::Placed(root.root.clone()))
            .collect(),
        is_read_only: !is_writable(&server.binding),
        sign_in_client: None,
        is_switch_kept_by_daemon: true,
        tool_defaults: McpServerToolDefaults::with_approval_mode(CLAUDE_TOOL_APPROVAL_MODE),
        organization_managed: server.organization_managed,
    };

    let declarations = reading
        .user_servers
        .iter()
        .chain(&reading.plugin_servers)
        .chain(
            reading
                .roots
                .iter()
                .flat_map(|root| root.local_servers.iter().chain(&root.project_servers)),
        )
        .map(declare)
        .collect();
    let roots = reading
        .roots
        .iter()
        .map(|root| {
            let mut provider_loaded: Vec<McpServerBindingRef> = Vec::new();
            if has_managed_mcp_file {
                let loaded = accounts
                    .iter()
                    .flat_map(|account| &account.organization_servers)
                    .filter(|server| {
                        !is_switched_off(&server.binding, &root.switched_off_server_names)
                    });
                for server in loaded {
                    if !provider_loaded.contains(&server.binding) {
                        provider_loaded.push(server.binding.clone());
                    }
                }
            }
            let mut kept_out_server_names = root.kept_out_server_names.clone();
            if has_managed_mcp_file {
                // Claude Code loads no server of the person's own beside the organization's.
                let declared = reading
                    .user_servers
                    .iter()
                    .chain(&reading.plugin_servers)
                    .chain(&root.local_servers)
                    .chain(&root.project_servers);
                for server in declared {
                    let name = server.binding.server_name();
                    if !kept_out_server_names.contains(name) {
                        kept_out_server_names.push(name.clone());
                    }
                }
            }
            kept_out_server_names.retain(|name| {
                !provider_loaded
                    .iter()
                    .any(|binding| binding.server_name() == name)
            });
            McpRootReading {
                root: root.root.clone(),
                kept_out_server_names,
                provider_loaded,
            }
        })
        .collect();
    let account_servers = accounts
        .iter()
        .map(|account| McpAccountServers {
            provider_account_id: account.provider_account_id.clone(),
            declarations: account
                .organization_servers
                .iter()
                .chain(&account.connectors)
                .map(declare)
                .collect(),
        })
        .collect();
    ClaudeMcpRanking {
        declarations,
        roots,
        account_servers,
    }
}

/// The servers of `sources` that another takes the place of at one root, by Claude Code's order:
/// the organization's servers, then `local`, `project` and `user`, each matched by name against
/// those above it; then the plugins' servers and the connectors, each matched by endpoint against
/// an enabled server above it.
pub(crate) fn find_superseded_claude_mcp_servers<'servers>(
    sources: &ClaudeMcpRootSources<'servers>,
) -> Vec<&'servers ClaudeMcpServer> {
    let mut kept: Vec<&ClaudeMcpServer> = Vec::new();
    let mut superseded = Vec::new();
    let named = [
        sources.organization,
        sources.local,
        sources.project,
        sources.user,
    ];
    for server in named.into_iter().flatten() {
        let name = server.binding.server_name();
        if kept.iter().any(|above| above.binding.server_name() == name) {
            superseded.push(server);
        } else {
            kept.push(server);
        }
    }
    for server in [sources.plugin, sources.connector].into_iter().flatten() {
        let is_duplicate = kept.iter().any(|above| {
            is_enabled(above, sources)
                && above.endpoint.is_some()
                && above.endpoint == server.endpoint
        });
        if is_duplicate {
            superseded.push(server);
        } else {
            kept.push(server);
        }
    }
    superseded
}

// Whether a server ranked above another is on at the root, so it can take a plugin's or a
// connector's place.
fn is_enabled(server: &ClaudeMcpServer, sources: &ClaudeMcpRootSources<'_>) -> bool {
    let is_kept_out = matches!(server.binding, McpServerBindingRef::Project { .. })
        && sources
            .kept_out_server_names
            .contains(server.binding.server_name());
    !is_kept_out && !is_switched_off(&server.binding, sources.switched_off_server_names)
}

// Whether Claude Code's per-project switch turns the server off, which records it by the name
// Claude Code reports it under.
fn is_switched_off(binding: &McpServerBindingRef, switched_off: &[McpServerName]) -> bool {
    let name = claude_reported_server_name(binding);
    switched_off.iter().any(|off| off.as_str() == name)
}

/// The name Claude Code reports a binding's server under and records it by: a plugin's as
/// `plugin:<plugin>:<server>`, every other by its own name.
pub(crate) fn claude_reported_server_name(binding: &McpServerBindingRef) -> String {
    match binding {
        McpServerBindingRef::Plugin {
            scope_ref,
            server_name,
            ..
        } => format!("plugin:{}:{}", scope_ref.as_str(), server_name.as_str()),
        McpServerBindingRef::User { server_name, .. }
        | McpServerBindingRef::Project { server_name, .. }
        | McpServerBindingRef::Local { server_name, .. }
        | McpServerBindingRef::Connector { server_name, .. }
        | McpServerBindingRef::Managed { server_name, .. } => server_name.as_str().to_owned(),
    }
}

fn is_writable(binding: &McpServerBindingRef) -> bool {
    match binding {
        McpServerBindingRef::User { .. }
        | McpServerBindingRef::Project { .. }
        | McpServerBindingRef::Local { .. } => true,
        McpServerBindingRef::Plugin { .. }
        | McpServerBindingRef::Connector { .. }
        | McpServerBindingRef::Managed { .. } => false,
    }
}

// Whether a binding reaches the root's sessions at all: a `project` or `local` one only at its own
// root, every other one everywhere.
fn is_declared_at(binding: &McpServerBindingRef, root: &PlacedPath) -> bool {
    match binding {
        McpServerBindingRef::Project {
            scope_ref, place, ..
        }
        | McpServerBindingRef::Local {
            scope_ref, place, ..
        } => *scope_ref == root.path && *place == root.place,
        McpServerBindingRef::User { .. }
        | McpServerBindingRef::Plugin { .. }
        | McpServerBindingRef::Connector { .. }
        | McpServerBindingRef::Managed { .. } => true,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use sidekicks_contracts::free_form_string::FilesystemPath;
    use sidekicks_contracts::mcp::server::config::McpServerConfigView;
    use sidekicks_contracts::mcp::server::inventory::McpOverrideOrigin;
    use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
    use sidekicks_contracts::place::PlacedPath;
    use sidekicks_contracts::provider::account::record::ProviderAccountId;

    use super::{ClaudeMcpAccountServers, rank_claude_mcp_servers};
    use crate::driver::claude::DESCRIPTOR;
    use crate::driver::claude::mcp::config::{
        ClaudeMcpConfigReading, ClaudeMcpEndpoint, ClaudeMcpRootConfig, ClaudeMcpServer,
    };
    use crate::driver::mcp_server::address::read_server_address;
    use crate::driver::mcp_server::read::{McpServerDeclaration, McpServerPolicy};

    fn server_name(name: &str) -> McpServerName {
        McpServerName::new(name.to_owned()).expect("a server name")
    }

    // A remote server at `address`, read as the config read reads one.
    fn remote_server(binding: McpServerBindingRef, address: &str) -> ClaudeMcpServer {
        let address = read_server_address(address);
        ClaudeMcpServer {
            binding,
            config: McpServerConfigView::Http {
                url: address.stripped_url,
                url_query_param_names: (!address.query_param_names.is_empty())
                    .then_some(address.query_param_names),
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
            endpoint: address.identity.map(ClaudeMcpEndpoint::Address),
            organization_managed: None,
        }
    }

    fn superseded_in<'ranked>(
        declarations: &'ranked [McpServerDeclaration],
        binding: &McpServerBindingRef,
    ) -> &'ranked [McpOverrideOrigin] {
        &declarations
            .iter()
            .find(|declaration| declaration.binding == *binding)
            .expect("the binding is declared")
            .superseded_in
    }

    // Killed by ranking a scope above the organization, by matching a connector on its stripped
    // address, which drops the query that keeps the second connector apart, by not folding the
    // address's case, default port and trailing slash, by the person's servers left loadable
    // under a managed file, and by a name the organization's server loads kept out.
    #[test]
    fn the_organization_outranks_every_scope_and_a_connector_yields_only_at_its_folded_address() {
        let provider = DESCRIPTOR.provider_id();
        let account_id =
            ProviderAccountId::new("account-1".to_owned()).expect("the test's account id");
        let root = PlacedPath {
            path: FilesystemPath::new("/work/project".to_owned()).expect("a root path"),
            place: None,
        };
        let user = |name: &str| McpServerBindingRef::User {
            provider: provider.clone(),
            server_name: server_name(name),
        };
        let connector = |name: &str| McpServerBindingRef::Connector {
            provider: provider.clone(),
            scope_ref: account_id.clone(),
            server_name: server_name(name),
        };
        let organization = McpServerBindingRef::Managed {
            provider: provider.clone(),
            server_name: server_name("github"),
        };
        let reading = ClaudeMcpConfigReading {
            user_servers: vec![
                remote_server(user("github"), "https://github.example.com/mcp"),
                remote_server(user("docs"), "https://Docs.Example.com:443/mcp"),
            ],
            plugin_servers: Vec::new(),
            roots: vec![ClaudeMcpRootConfig {
                root: root.clone(),
                local_servers: Vec::new(),
                project_servers: Vec::new(),
                kept_out_server_names: Vec::new(),
                switched_off_server_names: Vec::new(),
            }],
            server_policy: McpServerPolicy::default(),
        };
        let accounts = [ClaudeMcpAccountServers {
            provider_account_id: account_id.clone(),
            organization_servers: vec![remote_server(
                organization.clone(),
                "https://mcp.organization.example/github",
            )],
            connectors: vec![
                remote_server(connector("Docs"), "https://docs.example.com/mcp/"),
                remote_server(
                    connector("Docs team"),
                    "https://docs.example.com/mcp?team=b",
                ),
            ],
            connector_readings: Vec::new(),
            organization_entries: BTreeMap::new(),
        }];

        let ranking = rank_claude_mcp_servers(&reading, &accounts, true);

        let declarations = &ranking.declarations;
        let at_root = McpOverrideOrigin::Placed(root.clone());
        assert_eq!(
            superseded_in(declarations, &user("github")),
            [at_root.clone()]
        );
        assert!(superseded_in(declarations, &user("docs")).is_empty());
        let account_declarations = &ranking.account_servers[0].declarations;
        assert!(superseded_in(account_declarations, &organization).is_empty());
        assert_eq!(
            superseded_in(account_declarations, &connector("Docs")),
            [at_root]
        );
        assert!(superseded_in(account_declarations, &connector("Docs team")).is_empty());
        // Under a managed file Claude Code loads the organization's servers alone, so the
        // person's own are kept out but the one the organization's loads under its name.
        assert_eq!(ranking.roots[0].provider_loaded, [organization]);
        assert_eq!(
            ranking.roots[0].kept_out_server_names,
            [server_name("docs")]
        );
        let unmanaged = rank_claude_mcp_servers(&reading, &accounts, false);
        assert!(unmanaged.roots[0].kept_out_server_names.is_empty());
    }
}
