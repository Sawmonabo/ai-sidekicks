//! The read of the person's own Codex MCP config: one `config/read` per attached root on the
//! person's own Codex folder, each server's view taken from Codex's own merge and its bindings from
//! the layers that declare it, plus the servers of the plugins in the daemon's plugin home, bounded
//! by the allow list in Codex's requirements. Every credential-bearing value is dropped at the
//! read: a declaration keeps names only.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
use sidekicks_contracts::place::PlacedPath;

use crate::driver::codex::config_read::{CodexConfigRead, read_codex_config};
use crate::driver::codex::mcp::config::attribution::{
    attribute_codex_mcp_servers, find_plugin_switch_offs,
};
use crate::driver::codex::mcp::config::plugins::read_plugin_server_entries;
use crate::driver::codex::mcp::config::server_entry::CodexServerTransport;
use crate::driver::codex::mcp::requirements::read_codex_mcp_requirements;
use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::service::registry::personal_folder_read::PersonalFolderRead;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::mcp_server::read::{McpRootReading, McpServerDeclaration, McpServerPolicy};

mod attribution;
pub(super) mod plugins;
pub(super) mod server_entry;
#[cfg(test)]
mod tests;

/// One attached project root and the folder Codex reads it at on this computer.
#[derive(Clone, Debug)]
pub(crate) struct CodexMcpRoot {
    /// The root, with the distribution it is in.
    pub(crate) root: PlacedPath,
    /// The folder the root's `config/read` is asked for.
    pub(crate) folder: PathBuf,
}

/// Where the read finds the person's Codex config and the plugins beside it.
pub(crate) struct CodexMcpConfigSources<'sources> {
    /// The registry whose service on the person's own Codex folder answers the reads.
    pub(crate) registry: &'sources CodexServiceRegistry,
    /// The person's own home folder, read when no root is attached.
    pub(crate) home: &'sources Path,
    /// The daemon's plugin home for Codex, laid out as Codex lays out its own home's plugins.
    pub(crate) plugin_home: &'sources Path,
    /// The attached project roots.
    pub(crate) roots: &'sources [CodexMcpRoot],
    /// The folder Codex reads its administrator-managed requirements from; `None` where the
    /// system has none.
    pub(crate) managed_settings_folder: Option<&'sources Path>,
}

/// The person's Codex MCP config as the read found it.
#[derive(Clone, Debug)]
pub(crate) struct CodexMcpConfigReading {
    /// Each server the config's layers and the installed plugins declare, redacted.
    pub(crate) declarations: Vec<McpServerDeclaration>,
    /// What the read found at each attached root, in the order the roots were given.
    pub(crate) roots: Vec<McpRootReading>,
    /// Whether an administrator's layer on this computer declares any server.
    pub(crate) is_machine_managed: bool,
    /// The allow list of Codex's requirements, by server name; Codex keeps no deny list.
    pub(crate) server_policy: McpServerPolicy,
    /// The transport each declaration's view declares, as Codex compares it with its requirements.
    pub(crate) transports: Vec<(McpServerBindingRef, CodexServerTransport)>,
    /// The names of the servers a session at the person's home folder, in no attached root, never
    /// loads, since the requirements refuse them.
    pub(crate) home_kept_out_server_names: Vec<McpServerName>,
}

/// One `config/read` reply and the root it was read at; `None` for the read at the person's home
/// folder when no root is attached.
pub(crate) struct CodexRootConfigRead {
    /// The root.
    pub(crate) root: Option<PlacedPath>,
    /// The reply, its layers included.
    pub(crate) read: CodexConfigRead<Map<String, Value>>,
}

/// Reads the person's Codex MCP config from `sources`: Codex's config at each attached root, or at
/// the person's home folder when none is attached, on the person's own Codex folder, and the
/// plugins' servers, each root keeping out what the requirements' allow list does not allow. Fails
/// as the service there cannot be reached or a read fails; a plugin whose files cannot be read is
/// logged and skipped.
pub(crate) async fn read_codex_mcp_config(
    sources: &CodexMcpConfigSources<'_>,
) -> Result<CodexMcpConfigReading, CodexError> {
    let requirements = read_codex_mcp_requirements(sources.managed_settings_folder).await?;
    let mut reading = sources
        .registry
        .read_on_personal_folder(PersonalFolderRead::Config, |service| async move {
            let connection = service.connection()?;
            read_codex_mcp_config_over(
                &connection,
                sources.home,
                sources.plugin_home,
                sources.roots,
            )
            .await
        })
        .await?;
    if let Some(requirements) = requirements {
        requirements.apply(&mut reading);
    }
    Ok(reading)
}

// The read over `connection`: one `config/read` with its layers at each of `roots`, or once at
// `home` when none is attached, then the plugins in `plugin_home`. Fails as a read fails.
async fn read_codex_mcp_config_over(
    connection: &CodexAppServerConnection,
    home: &Path,
    plugin_home: &Path,
    roots: &[CodexMcpRoot],
) -> Result<CodexMcpConfigReading, CodexError> {
    let mut reads = Vec::with_capacity(roots.len().max(1));
    if roots.is_empty() {
        reads.push(CodexRootConfigRead {
            root: None,
            read: read_codex_config(connection, home, true).await?,
        });
    }
    for root in roots {
        reads.push(CodexRootConfigRead {
            root: Some(root.root.clone()),
            read: read_codex_config(connection, &root.folder, true).await?,
        });
    }
    let mut reading = attribute_codex_mcp_servers(&reads);
    for mut server in read_plugin_server_entries(plugin_home).await {
        server.declaration.disabled_in = find_plugin_switch_offs(
            &reads,
            &server.plugin_key,
            server.declaration.binding.server_name().as_str(),
        );
        if let Some(transport) = server.read_transport() {
            reading
                .transports
                .push((server.declaration.binding.clone(), transport));
        }
        reading.declarations.push(server.declaration);
    }
    Ok(reading)
}
