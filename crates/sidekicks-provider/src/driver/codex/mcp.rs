//! Codex's MCP servers as the driver reads them: the person's own config, as Codex layers it, and
//! the servers of the plugins in the daemon's plugin home, bounded by the allow list of Codex's
//! requirements; and, when a read asks for one, the machine probe of the servers it names.

mod config;
pub(super) mod machine_probe;
mod requirements;
pub(super) mod status_list;

use std::path::{Path, PathBuf};

use sidekicks_store::data_folder::plugin_home;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::mcp::config::plugins::read_plugin_server_entries;
use crate::driver::codex::mcp::config::{CodexMcpRoot, read_codex_mcp_config};
use crate::driver::codex::mcp::machine_probe::{
    codex_probe_targets, plan_codex_mcp_probe, probe_codex_mcp_servers,
};
use crate::driver::codex::mcp::requirements::read_codex_mcp_requirements;
use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::service::registry::personal_folder_read::PersonalFolderRead;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::mcp_server::read::{
    McpProbeScope, McpServersReadRequest, ProviderMcpServersReading,
};

/// What Codex's MCP servers are on this computer for `request`: the declarations, roots and allow
/// list the config read finds on `registry`'s service on the person's own Codex folder, `home`
/// being the person's home folder, and what the machine probe read of each binding the request's
/// probe scope names, its emulated `local` bindings among them, which runs only when it names
/// one. A read that may probe runs the config read and the probe on one probe's service. Codex
/// brings no account's servers and keeps nothing between reads, so a refresh reads as any read
/// does. Fails as the requirements or the config read fail, or as the service cannot be started
/// or a probe request fails.
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
    let requirements = read_codex_mcp_requirements(managed_settings_folder.as_deref()).await?;
    let purpose = match request.probe {
        McpProbeScope::None => PersonalFolderRead::Config,
        McpProbeScope::EveryBinding | McpProbeScope::Bindings(_) => PersonalFolderRead::Probe,
    };
    let plugin_home = plugin_home.as_path();
    let roots = roots.as_slice();
    let requirements = requirements.as_ref();
    let (reading, probe_readings) = registry
        .read_on_personal_folder(purpose, |service| async move {
            let connection = service.connection()?;
            let mut reading = read_codex_mcp_config(&connection, home, plugin_home, roots).await?;
            if let Some(requirements) = requirements {
                requirements.apply(&mut reading);
            }
            let probe_targets = codex_probe_targets(&reading.declarations, request);
            if probe_targets.is_empty() {
                return Ok((reading, Vec::new()));
            }
            let plugin_servers = read_plugin_server_entries(plugin_home).await;
            let sites =
                plan_codex_mcp_probe(&probe_targets, &reading, roots, home, &plugin_servers);
            let probe_readings = probe_codex_mcp_servers(&service, &sites).await?;
            Ok((reading, probe_readings))
        })
        .await?;
    Ok(ProviderMcpServersReading {
        declarations: reading.declarations,
        roots: reading.roots,
        is_machine_managed: reading.is_machine_managed,
        server_policy: reading.server_policy,
        account_servers: Vec::new(),
        probe_readings,
    })
}
