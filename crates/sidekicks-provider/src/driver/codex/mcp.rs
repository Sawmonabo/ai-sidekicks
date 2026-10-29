//! Codex's MCP servers as the driver reads them: the person's own config, as Codex layers it, and
//! the servers of the plugins in the daemon's plugin home, bounded by the allow list of Codex's
//! requirements; when a read asks for one, the machine probe of the servers it names; and the
//! sign-in to one server through Codex's own client.

mod config;
pub(super) mod machine_probe;
mod requirements;
pub(super) mod sign_in;

use std::path::{Path, PathBuf};

use sidekicks_store::data_folder::plugin_home;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::mcp::config::plugins::read_plugin_server_entries;
use crate::driver::codex::mcp::config::{
    CodexMcpConfigSources, CodexMcpRoot, read_codex_mcp_config,
};
use crate::driver::codex::mcp::machine_probe::{plan_codex_mcp_probe, probe_codex_mcp_servers};
use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::mcp_server::read::{McpServersReadRequest, ProviderMcpServersReading};

/// What Codex's MCP servers are on this computer for `request`: the declarations, roots and allow
/// list the config read finds on `registry`'s service on the person's own Codex folder, `home`
/// being the person's home folder, and what the machine probe read of each of the request's probe
/// targets, which runs only when there is one. Codex brings no account's servers and keeps nothing
/// between reads, so a refresh reads as any read does. Fails as the config read fails, or as the
/// probe's service cannot be started or a probe request fails.
pub(crate) async fn read_codex_mcp_servers(
    registry: &CodexServiceRegistry,
    home: &Path,
    request: &McpServersReadRequest,
) -> Result<ProviderMcpServersReading, CodexError> {
    let plugin_home = plugin_home(home, &DESCRIPTOR.provider_id());
    let managed_settings_folder = DESCRIPTOR.managed_settings_folder();
    let roots: Vec<CodexMcpRoot> = request
        .attached_roots
        .iter()
        .map(|root| CodexMcpRoot {
            root: root.clone(),
            folder: PathBuf::from(root.path.as_str()),
        })
        .collect();
    let sources = CodexMcpConfigSources {
        registry,
        home,
        plugin_home: &plugin_home,
        roots: &roots,
        managed_settings_folder: managed_settings_folder.as_deref(),
    };
    let reading = read_codex_mcp_config(&sources).await?;
    let probe_readings = if request.probe_targets.is_empty() {
        Vec::new()
    } else {
        let plugin_servers = read_plugin_server_entries(sources.plugin_home).await;
        let sites = plan_codex_mcp_probe(
            &request.probe_targets,
            &reading,
            sources.roots,
            sources.home,
            &plugin_servers,
        );
        probe_codex_mcp_servers(sources.registry, &sites).await?
    };
    Ok(ProviderMcpServersReading {
        declarations: reading.declarations,
        roots: reading.roots,
        is_machine_managed: reading.is_machine_managed,
        server_policy: reading.server_policy,
        account_servers: Vec::new(),
        probe_readings,
    })
}
