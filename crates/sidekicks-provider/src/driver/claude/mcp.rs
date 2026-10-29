//! Claude Code's MCP servers as the driver reads them: the person's own config, each account's
//! connectors and organization servers, Claude Code's precedence over them, and the machine probe
//! of the bindings no live session reads.

mod config;
pub(crate) mod connectors;
pub(crate) mod machine_probe;
pub(crate) mod organization;
pub(crate) mod precedence;

use std::path::PathBuf;

use futures::future::join_all;
use sidekicks_contracts::mcp::server::McpServerStatus;
use sidekicks_store::data_folder::plugin_home;

use self::config::{ClaudeMcpConfigSources, ClaudeMcpRoot, read_claude_mcp_config};
use self::machine_probe::{ClaudeMcpProbeSources, claude_probe_target, probe_claude_mcp_servers};
use self::organization::has_readable_managed_mcp_file;
use self::precedence::{ClaudeMcpAccountServers, rank_claude_mcp_servers};
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::lifecycle::ClaudeDriver;
use crate::driver::contract::error::DriverError;
use crate::driver::mcp_server::read::{
    McpProbeReading, McpProbeTarget, McpServersReadRequest, ProviderMcpServersReading,
};
use crate::driver::mcp_server::status::McpServerReading;

/// Answers which MCP servers Claude Code declares and loads on this computer for `request`: the
/// person's config ranked under each requested account's connectors and organization servers, a
/// refresh also re-reading each account and each live session's server status and answering what
/// each account's process reported of its connectors as their probe readings, and the probe's
/// readings of each declared binding the request's probe scope names. A connector is never
/// probed, since its account's process already reports it; with no account no Claude Code process
/// can run, so each target reads `unknown`. Fails as the config read, an account read or the probe
/// does.
pub(crate) async fn read_claude_mcp_servers(
    driver: &ClaudeDriver,
    request: McpServersReadRequest,
) -> Result<ProviderMcpServersReading, DriverError> {
    let sources = &driver.sources;
    let managed_settings_folder = DESCRIPTOR.managed_settings_folder();
    let has_managed_mcp_file =
        has_readable_managed_mcp_file(managed_settings_folder.as_deref()).await;
    let plugin_home = plugin_home(&sources.home_folder, &DESCRIPTOR.provider_id());
    let roots: Vec<ClaudeMcpRoot> = request
        .attached_roots
        .iter()
        .map(|root| ClaudeMcpRoot {
            root: root.clone(),
            folder: PathBuf::from(root.path.as_str()),
        })
        .collect();
    let config_sources = ClaudeMcpConfigSources {
        home: &sources.home_folder,
        managed_settings_folder: managed_settings_folder.as_deref(),
        plugin_home: &plugin_home,
        roots: &roots,
    };
    let account_reads = join_all(
        request
            .provider_account_ids
            .iter()
            .map(|account| driver.account_servers.read(account, request.is_refresh)),
    );
    let live_reads = async {
        let live_sessions = match driver.composed_parts() {
            Some(parts) if request.is_refresh => parts.slots().live_sessions(),
            Some(_) | None => Vec::new(),
        };
        join_all(live_sessions.iter().map(|live| live.read_mcp_status())).await;
    };
    let (reading, account_reads, ()) = tokio::join!(
        read_claude_mcp_config(&config_sources),
        account_reads,
        live_reads
    );
    let reading = reading.map_err(|error| DriverError::Internal(Box::new(error)))?;
    let accounts = account_reads
        .into_iter()
        .map(|read| {
            read.map(|servers| ClaudeMcpAccountServers::clone(&servers))
                .map_err(|error| DriverError::Internal(Box::new(error)))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let ranking = rank_claude_mcp_servers(&reading, &accounts, has_managed_mcp_file);
    let mut probe_readings: Vec<McpProbeReading> = if request.is_refresh {
        accounts
            .iter()
            .flat_map(|account| account.connector_readings.iter().cloned())
            .collect()
    } else {
        Vec::new()
    };
    let probe_targets: Vec<McpProbeTarget> = ranking
        .declarations
        .iter()
        .chain(
            ranking
                .account_servers
                .iter()
                .flat_map(|account| &account.declarations),
        )
        .filter(|declaration| request.probe.contains(&declaration.binding))
        .filter_map(|declaration| claude_probe_target(&declaration.binding))
        .collect();
    if !probe_targets.is_empty() {
        match accounts.first() {
            None => {
                probe_readings.extend(probe_targets.into_iter().map(|target| McpProbeReading {
                    binding: target.binding,
                    reading: McpServerReading::Observed(McpServerStatus::Unknown),
                    failure_text: None,
                    tool_names: Vec::new(),
                }))
            }
            Some(account) => {
                let probe_sources = ClaudeMcpProbeSources {
                    starts: &*driver.starts,
                    environment: sources
                        .account_environment(&account.provider_account_id)
                        .await?,
                    provider_account_id: account.provider_account_id.clone(),
                    has_managed_mcp_file,
                    home: &sources.home_folder,
                    plugin_home: &plugin_home,
                    attached_roots: &request.attached_roots,
                    organization_entries: &account.organization_entries,
                };
                probe_readings
                    .extend(probe_claude_mcp_servers(&probe_sources, &probe_targets).await?);
            }
        }
    }
    Ok(ProviderMcpServersReading {
        declarations: ranking.declarations,
        roots: ranking.roots,
        is_machine_managed: has_managed_mcp_file,
        server_policy: reading.server_policy,
        account_servers: ranking.account_servers,
        probe_readings,
    })
}
