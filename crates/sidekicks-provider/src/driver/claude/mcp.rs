//! Claude Code's MCP servers as the driver reads them: the person's own config, each account's
//! connectors and organization servers, Claude Code's precedence over them, and the machine probe
//! of the bindings no live session reads.

mod config;
pub(crate) mod connectors;
pub(crate) mod machine_probe;
pub(crate) mod organization;
pub(crate) mod precedence;

use std::path::{Path, PathBuf};

use futures::future::join_all;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerStatus};
use sidekicks_ipc::redaction::sanitize_failure_chain;
use sidekicks_store::data_folder::plugin_home;

use self::config::{
    ClaudeMcpConfigSources, ClaudeMcpRoot, ClaudePersonConfigFiles, read_claude_mcp_config,
};
use self::machine_probe::{
    ClaudeMcpProbeSources, ClaudeProbePlan, plan_claude_probe, probe_claude_mcp_servers,
};
use self::organization::has_readable_managed_mcp_file;
use self::precedence::{ClaudeMcpAccountServers, rank_claude_mcp_servers};
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::lifecycle::ClaudeDriver;
use crate::driver::claude::session::account_servers::ClaudeAccountReadAsk;
use crate::driver::contract::error::DriverError;
use crate::driver::mcp_server::read::{
    McpProbeReading, McpProbeTarget, McpServersReadRequest, ProviderMcpServersReading,
};
use crate::driver::mcp_server::status::{FAILURE_TEXT_MAX_CODE_POINTS, McpServerReading};

/// Answers which MCP servers Claude Code declares and loads on this computer for `request`: the
/// person's config ranked under each requested account's connectors and organization servers, a
/// refresh also re-reading each account and answering what each account's process reported of its
/// connectors as their probe readings, and the probe's readings of each declared binding the
/// request's probe scope names, the managed settings read from `managed_settings_folder`. An
/// account whose read failed brings no servers, its failure recorded where the read ran. A
/// connector is never probed, since its account's process already reports it, nor is an
/// organization's server that process reports past `pending`, which reads as reported; any other
/// organization server is probed under the first account that brings it, and every other binding
/// under the first account that answered; with no such account no Claude Code process can run, so
/// each target reads `unknown`, carrying the first account's failure as its failure text where
/// accounts were asked. Fails as the config read or the probe does.
pub(crate) async fn read_claude_mcp_servers(
    driver: &ClaudeDriver,
    managed_settings_folder: Option<&Path>,
    request: McpServersReadRequest,
) -> Result<ProviderMcpServersReading, DriverError> {
    let sources = &driver.sources;
    let has_managed_mcp_file = has_readable_managed_mcp_file(managed_settings_folder).await;
    let plugin_home = plugin_home(&sources.home_folder, &DESCRIPTOR.provider_id());
    let roots: Vec<ClaudeMcpRoot> = request
        .attached_roots
        .iter()
        .map(|root| ClaudeMcpRoot {
            root: root.clone(),
            folder: PathBuf::from(root.path.as_str()),
        })
        .collect();
    let person =
        ClaudePersonConfigFiles::resolve(&sources.base_environment, &sources.home_folder).await;
    let config_sources = ClaudeMcpConfigSources {
        person: &person,
        managed_settings_folder,
        plugin_home: &plugin_home,
        roots: &roots,
    };
    let account_reads = join_all(request.provider_account_ids.iter().map(|account| {
        let ask = if request.is_refresh {
            ClaudeAccountReadAsk::Refresh
        } else {
            ClaudeAccountReadAsk::List
        };
        driver.account_servers.read(account, ask)
    }));
    let (reading, account_reads) =
        tokio::join!(read_claude_mcp_config(&config_sources), account_reads);
    let reading = reading.map_err(|error| DriverError::Internal(Box::new(error)))?;
    let mut account_failure = None;
    let mut accounts: Vec<ClaudeMcpAccountServers> = Vec::new();
    for read in account_reads {
        match read {
            Ok(servers) => accounts.push(ClaudeMcpAccountServers::clone(&servers)),
            Err(error) => {
                account_failure.get_or_insert_with(|| {
                    sanitize_failure_chain(&*error, FAILURE_TEXT_MAX_CODE_POINTS)
                });
            }
        }
    }
    let ranking = rank_claude_mcp_servers(&reading, &accounts, has_managed_mcp_file);
    let mut probe_readings: Vec<McpProbeReading> = if request.is_refresh {
        accounts
            .iter()
            .flat_map(|account| account.connector_readings.iter().cloned())
            .collect()
    } else {
        Vec::new()
    };
    // Each account's targets: its organization's servers, and under the first account every other
    // binding too, each binding once.
    let mut targets_by_account: Vec<Vec<McpProbeTarget>> = vec![Vec::new(); accounts.len().max(1)];
    let mut planned: Vec<&McpServerBindingRef> = Vec::new();
    let declared = ranking
        .declarations
        .iter()
        .map(|declaration| (0, declaration))
        .chain(
            ranking
                .account_servers
                .iter()
                .enumerate()
                .flat_map(|(index, account)| {
                    account
                        .declarations
                        .iter()
                        .map(move |declaration| (index, declaration))
                }),
        );
    for (index, declaration) in declared {
        if !request.probe.contains(&declaration.binding) || planned.contains(&&declaration.binding)
        {
            continue;
        }
        planned.push(&declaration.binding);
        match plan_claude_probe(&declaration.binding, &reading.roots) {
            Some(ClaudeProbePlan::Probe(target)) => {
                let reported = accounts.get(index).and_then(|account| {
                    account
                        .organization_readings
                        .iter()
                        .find(|reading| reading.binding == target.binding)
                });
                match reported {
                    Some(reading) => probe_readings.push(reading.clone()),
                    None => targets_by_account[index].push(target),
                }
            }
            Some(ClaudeProbePlan::Withheld(reading)) => probe_readings.push(reading),
            None => {}
        }
    }
    if accounts.is_empty() {
        let targets = targets_by_account.into_iter().flatten();
        probe_readings.extend(targets.map(|target| McpProbeReading {
            binding: target.binding,
            reading: McpServerReading::Observed(McpServerStatus::Unknown),
            failure_text: account_failure.clone(),
            tool_names: Vec::new(),
        }));
    } else {
        for (account, targets) in accounts.iter().zip(&targets_by_account) {
            if targets.is_empty() {
                continue;
            }
            let probe_sources = ClaudeMcpProbeSources {
                starts: &*driver.starts,
                environment: sources
                    .account_environment(&account.provider_account_id)
                    .await?,
                provider_account_id: account.provider_account_id.clone(),
                has_managed_mcp_file,
                person: &person,
                plugin_home: &plugin_home,
                attached_roots: &request.attached_roots,
                organization_entries: &account.organization_entries,
            };
            probe_readings.extend(probe_claude_mcp_servers(&probe_sources, targets).await?);
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

/// Asks each live session's process for its MCP servers' status again, each reply reported to its
/// leg; a session whose process does not answer reports nothing.
pub(crate) async fn reread_claude_live_mcp_statuses(driver: &ClaudeDriver) {
    let live_sessions = driver
        .composed_parts()
        .map(|parts| parts.slots().live_sessions())
        .unwrap_or_default();
    join_all(live_sessions.iter().map(|live| live.read_mcp_status())).await;
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;
    use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerStatus};
    use sidekicks_contracts::wire::text::FreeFormText;

    use super::read_claude_mcp_servers;
    use crate::driver::claude::session::scripted::channel::{ScriptedAnswer, ScriptedChannel};
    use crate::driver::claude::session::scripted::driver::ScriptedDriver;
    use crate::driver::mcp_server::read::{McpProbeScope, McpServersReadRequest};
    use crate::driver::mcp_server::status::McpServerReading;
    use crate::runtime_binding::test_store::test_provider_account_id;

    // A refresh that probes every binding of the test's account.
    fn refresh_probing_everything() -> McpServersReadRequest {
        McpServersReadRequest {
            attached_roots: Vec::new(),
            provider_account_ids: vec![test_provider_account_id()],
            is_refresh: true,
            probe: McpProbeScope::EveryBinding,
            emulated_local_bindings: Vec::new(),
        }
    }

    // With every asked account's read failing, no Claude Code process can run a probe, so a
    // personal server reads `unknown` with the account's failure as its failure text. Killed by
    // the reading left without a cause.
    #[tokio::test]
    async fn an_unprobed_server_names_the_failed_account_read() {
        let fixture = ScriptedDriver::new();
        let managed_settings = tempfile::tempdir().expect("an empty managed settings folder");
        let home = &fixture.driver.sources.home_folder;
        std::fs::create_dir_all(home).expect("the home folder is made");
        std::fs::write(
            home.join(".claude.json"),
            json!({ "mcpServers": { "notes": { "command": "notes-server" } } }).to_string(),
        )
        .expect("the config is written");
        let failing = Arc::new(ScriptedChannel::default());
        failing.answer("get_binary_version", ScriptedAnswer::Refused);
        fixture.starts.script_account_servers_read(failing);

        let reading = read_claude_mcp_servers(
            &fixture.driver,
            Some(managed_settings.path()),
            refresh_probing_everything(),
        )
        .await
        .expect("the read answers");

        let [notes] = reading.probe_readings.as_slice() else {
            panic!("one reading: {:?}", reading.probe_readings);
        };
        assert!(matches!(&notes.binding, McpServerBindingRef::User { .. }));
        assert_eq!(
            notes.reading,
            McpServerReading::Observed(McpServerStatus::Unknown)
        );
        let failure_text = notes.failure_text.as_deref().unwrap_or_default();
        assert!(
            failure_text.contains("get_binary_version"),
            "{failure_text}"
        );
    }
    // An organization server the account's process reports past `pending` reads as its row
    // reports it, with its tools, and starts no probe, though its entry signs in itself and could
    // not be sent whole. Killed by the row's reading left unused, which reads `unknown`
    // unsent.
    #[tokio::test]
    async fn an_organization_server_its_account_reports_reads_as_its_row() {
        let fixture = ScriptedDriver::new();
        let managed_settings = tempfile::tempdir().expect("an empty managed settings folder");
        std::fs::create_dir_all(&fixture.driver.sources.home_folder)
            .expect("the home folder is made");
        fixture.starts.script_account_servers(
            json!({ "mcpServers": [{
                "name": "org-signed",
                "status": "connected",
                "scope": "managed",
                "config": { "type": "http", "url": "https://org-signed.example.com" },
                "tools": [{ "name": "search" }]
            }] }),
            json!({ "effective": { "managedMcpServers": { "org-signed": {
                "type": "http",
                "url": "https://org-signed.example.com/mcp",
                "oauth": { "clientId": "client" }
            } } } }),
        );

        let reading = read_claude_mcp_servers(
            &fixture.driver,
            Some(managed_settings.path()),
            refresh_probing_everything(),
        )
        .await
        .expect("the read answers");

        let organization = reading
            .probe_readings
            .iter()
            .find(|reading| matches!(&reading.binding, McpServerBindingRef::Managed { .. }))
            .expect("the organization server has a reading");
        assert_eq!(
            organization.reading,
            McpServerReading::Observed(McpServerStatus::Connected)
        );
        let tool_names: Vec<&str> = organization
            .tool_names
            .iter()
            .map(FreeFormText::as_str)
            .collect();
        assert_eq!(tool_names, ["search"]);
        assert!(fixture.starts.take_mcp_probe_starts().is_empty());
    }
}
