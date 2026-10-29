//! Codex's MCP servers as the driver reads them: the person's own config, as Codex layers it, and
//! the servers of the plugins in the daemon's plugin home, bounded by the allow list of Codex's
//! requirements; and, when a read asks for one, the machine probe of the servers it names.

mod config;
pub(super) mod machine_probe;
mod requirements;

use crate::driver::codex::mcp::config::plugins::read_plugin_server_entries;
use crate::driver::codex::mcp::config::{CodexMcpConfigSources, read_codex_mcp_config};
use crate::driver::codex::mcp::machine_probe::{plan_codex_mcp_probe, probe_codex_mcp_servers};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::mcp_server::read::{McpProbeTarget, ProviderMcpServersReading};

/// What Codex's MCP servers are on this computer: the declarations, roots and allow list the
/// config read finds, and what the machine probe read of each of `probe_targets`, which runs only
/// when there is one. Codex brings no account's servers here. Fails as the config read fails, or
/// as the probe's service cannot be started or a probe request fails.
#[expect(
    dead_code,
    reason = "the Codex driver's answer to the daemon's MCP server read"
)]
pub(crate) async fn read_codex_mcp_servers(
    sources: &CodexMcpConfigSources<'_>,
    probe_targets: &[McpProbeTarget],
) -> Result<ProviderMcpServersReading, CodexError> {
    let reading = read_codex_mcp_config(sources).await?;
    let probe_readings = if probe_targets.is_empty() {
        Vec::new()
    } else {
        let plugin_servers = read_plugin_server_entries(sources.plugin_home).await;
        let sites = plan_codex_mcp_probe(
            probe_targets,
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
