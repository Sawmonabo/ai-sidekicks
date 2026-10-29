//! The read of the person's own Codex MCP config: one `config/read` per attached root on the
//! person's own Codex folder, each server's view taken from Codex's own merge, or from its own
//! layer where another binding takes its place, and its bindings from the layers that declare it,
//! plus the servers of the plugins in the daemon's plugin home. Every credential-bearing value is
//! dropped at the read: a declaration keeps names only.

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
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::mcp_server::read::{McpRootReading, McpServerDeclaration, McpServerPolicy};

pub(super) mod attribution;
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
    /// The key Codex's config names each plugin's server's plugin by, `<plugin>@<marketplace>`.
    pub(crate) plugin_keys: Vec<(McpServerBindingRef, String)>,
    /// The names of the servers a session at the person's home folder, in no attached root, never
    /// loads, since the requirements refuse them.
    pub(crate) home_kept_out_server_names: Vec<McpServerName>,
    /// The plugins' servers Codex's requirements refuse when the probe sends them as entries of
    /// its own config: those their plugin's list or the top-level list refuses.
    pub(crate) refused_when_sent: Vec<McpServerBindingRef>,
    /// The binding each read's place loads under each name its config declares, and whether
    /// Codex's merge there switches it on.
    pub(crate) loaded_servers: Vec<CodexLoadedServer>,
    /// The keys of the plugins the person's config names, `<plugin>@<marketplace>`, each a plugin
    /// of the person's own Codex folder.
    pub(crate) person_plugin_keys: Vec<String>,
}

impl CodexMcpConfigReading {
    /// The transport `binding`'s view declares; `None` where it declares none Codex compares.
    pub(crate) fn transport_of(
        &self,
        binding: &McpServerBindingRef,
    ) -> Option<&CodexServerTransport> {
        self.transports
            .iter()
            .find(|(declared, _transport)| declared == binding)
            .map(|(_binding, transport)| transport)
    }

    /// The key of the plugin `binding` is a server of; `None` for any other binding.
    pub(crate) fn plugin_key_of(&self, binding: &McpServerBindingRef) -> Option<&str> {
        self.plugin_keys
            .iter()
            .find(|(declared, _key)| declared == binding)
            .map(|(_binding, key)| key.as_str())
    }
}

/// The binding one place's config loads under one name: an attached root's, or the person's home
/// folder's where no root is attached.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct CodexLoadedServer {
    /// The root; `None` for the person's home folder.
    pub(crate) root: Option<PlacedPath>,
    /// The binding of the highest layer there that declares the name with a transport.
    pub(crate) binding: McpServerBindingRef,
    /// Whether Codex's merged entry there leaves the server switched on.
    pub(crate) is_switched_on: bool,
}

/// One `config/read` reply and the root it was read at; `None` for the read at the person's home
/// folder when no root is attached.
pub(crate) struct CodexRootConfigRead {
    /// The root.
    pub(crate) root: Option<PlacedPath>,
    /// The reply, its layers included.
    pub(crate) read: CodexConfigRead<Map<String, Value>>,
}

/// Reads the person's Codex MCP config over `connection`, a service on the person's own Codex
/// folder: one `config/read` with its layers at each of `roots`, or once at `home` when none is
/// attached, then the servers of the plugins in `plugin_home`, the daemon's plugin home. Fails as a
/// read fails; a plugin whose files cannot be read is logged and skipped.
pub(crate) async fn read_codex_mcp_config(
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
        reading
            .plugin_keys
            .push((server.declaration.binding.clone(), server.plugin_key));
        reading.declarations.push(server.declaration);
    }
    Ok(reading)
}
