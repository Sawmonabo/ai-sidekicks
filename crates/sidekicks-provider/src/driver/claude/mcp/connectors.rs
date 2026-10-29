//! The account read of Claude Code's claude.ai connectors and its organization's servers: one
//! process that keeps nothing, started under the account without `--strict-mcp-config` in an
//! empty folder under the account's home, so nothing of the person's loads, answers `mcp_status`
//! and `get_settings`, and each `claudeai` row becomes a read-only connector of the account, with
//! the status and tools the row reports, while the organization's rows and `managedMcpServers`
//! become read-only managed servers, each connector marked as its organization's connector list
//! reads it. Budget: one such process of about 140 to 150 MB per account at a time, run at the
//! account's first session after the daemon starts and again only on a refresh, never on a poll.

pub(crate) mod organization_mark;

use std::path::PathBuf;

use serde_json::value::RawValue;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
use sidekicks_contracts::provider::account::record::ProviderAccountId;

use crate::driver::ReportedVersionReading;
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::mcp::config::{ClaudeMcpEndpoint, ClaudeMcpServer};
use crate::driver::claude::mcp::connectors::organization_mark::ClaudeConnectorMarks;
use crate::driver::claude::mcp::organization::{
    read_claude_organization_servers, remote_server_view,
};
use crate::driver::claude::mcp::precedence::ClaudeMcpAccountServers;
use crate::driver::claude::session::errors::ClaudeSessionError;
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::claude::session::transport::control::{
    ClaudeControlRequest, ClaudeSettingsReply,
};
use crate::driver::claude::session::transport::mcp_status::{
    ClaudeMcpServerStatusRow, ClaudeMcpStatusReply,
};
use crate::driver::claude::spawn::launch::control_only::ClaudeShortProcess;
use crate::driver::claude::spawn::launch::{ClaudeLaunchError, ClaudeProcessLauncher};
use crate::driver::claude::tools::normalize_claude_mcp_status_reply;
use crate::driver::claude::version::read_reported_version;
use crate::driver::mcp_server::read::McpProbeReading;
use crate::driver::mcp_server::status::McpServerStatusEmission;
use crate::spawned_version::ResolvedProviderExecutable;

/// Where one account's read runs: the account's process environment, the account, and the empty
/// folder under its home the process starts in.
pub(crate) struct ClaudeAccountServersReadRequest {
    /// The environment of a process on the account's home.
    pub(crate) environment: Vec<(String, String)>,
    /// The account.
    pub(crate) provider_account_id: ProviderAccountId,
    /// The empty folder the process runs in, made where absent.
    pub(crate) working_folder: PathBuf,
}

/// What one account's process answered, unread: its `mcp_status` and `get_settings` replies,
/// which can carry headers and whole addresses, so they live only until they are read, and the
/// version of the build that answered.
pub(crate) struct ClaudeAccountServerAnswers {
    /// The `mcp_status` reply.
    pub(crate) mcp_status: Option<Box<RawValue>>,
    /// The `get_settings` reply.
    pub(crate) settings: Option<Box<RawValue>>,
    /// The build's canonical version, as its `get_binary_version` reply reports it; `None` where
    /// the reply carries none.
    pub(crate) build_version: Option<String>,
}

/// Starts one process that keeps nothing on `executable` under `provider_account_id`'s account in
/// `working_folder`, made where absent, and takes its `mcp_status`, `get_settings` and
/// `get_binary_version` answers. Fails with `ControlOnlyFolder` when the folder cannot be made, and
/// as the start or a request does, a refused request included; the process is closed either way.
pub(crate) async fn read_claude_account_answers(
    launcher: &ClaudeProcessLauncher,
    executable: &ResolvedProviderExecutable,
    provider_account_id: ProviderAccountId,
    working_folder: PathBuf,
) -> Result<ClaudeAccountServerAnswers, ClaudeLaunchError> {
    tokio::fs::create_dir_all(&working_folder)
        .await
        .map_err(ClaudeLaunchError::ControlOnlyFolder)?;
    let short = ClaudeShortProcess::start_control_only(
        launcher,
        executable,
        Some(working_folder),
        None,
        Some(provider_account_id),
    )
    .await?;
    let read = async {
        short.initialize().await?;
        let mcp_status = short
            .process
            .send_control_request(ClaudeControlRequest::McpStatus {})
            .await?;
        let settings = short
            .process
            .send_control_request(ClaudeControlRequest::GetSettings {})
            .await?;
        let version = short
            .process
            .send_control_request(ClaudeControlRequest::GetBinaryVersion {})
            .await?;
        Ok::<_, ClaudeSessionError>(ClaudeAccountServerAnswers {
            mcp_status: mcp_status.response,
            settings: settings.response,
            build_version: read_build_version(version.response.as_deref()),
        })
    }
    .await;
    short.close().await;
    Ok(read?)
}

/// The servers `provider_account_id` brings, read from its process's `answers`: each `claudeai`
/// row as a connector named by its display name, with the status, error text and tools the row
/// reports and its mark from `marks`, and the organization's servers. Every other row is the
/// person's own config, which the config read lists.
pub(crate) fn read_claude_account_servers(
    provider_account_id: &ProviderAccountId,
    answers: &ClaudeAccountServerAnswers,
    marks: Option<&ClaudeConnectorMarks>,
) -> ClaudeMcpAccountServers {
    let reply = ClaudeMcpStatusReply::read(answers.mcp_status.as_deref());
    let emissions = normalize_claude_mcp_status_reply(&reply)
        .map(|read| read.emissions)
        .unwrap_or_default();
    let rows = reply.servers.map(|rows| rows.0).unwrap_or_default();
    let settings = ClaudeSettingsReply::read(answers.settings.as_deref());
    let organization = read_claude_organization_servers(&rows, settings.effective.as_ref());
    let (connectors, connector_readings) = rows
        .iter()
        .filter(|row| is_connector_row(row))
        .filter_map(|row| {
            let connector = read_connector(provider_account_id, row, marks)?;
            let reading = read_connector_reading(&connector, row, &emissions)?;
            Some((connector, reading))
        })
        .unzip();
    ClaudeMcpAccountServers {
        provider_account_id: provider_account_id.clone(),
        organization_servers: organization.servers,
        connectors,
        connector_readings,
        organization_entries: organization.entries,
    }
}

// Whether the account's process reports any connector, so its organization marks are worth a read.
fn lists_connectors(answers: &ClaudeAccountServerAnswers) -> bool {
    ClaudeMcpStatusReply::read(answers.mcp_status.as_deref())
        .servers
        .is_some_and(|rows| rows.0.iter().any(is_connector_row))
}

// Whether `row` is one of the account's claude.ai connectors.
fn is_connector_row(row: &ClaudeMcpServerStatusRow) -> bool {
    row.source.as_deref().or(row.scope.as_deref()) == Some("claudeai")
}

// The canonical version a `get_binary_version` `reply` reports; `None` where it reports none.
fn read_build_version(reply: Option<&RawValue>) -> Option<String> {
    let reply: serde_json::Value = serde_json::from_str(reply?.get()).ok()?;
    match read_reported_version(&reply) {
        ReportedVersionReading::Version(version) => Some(version),
        ReportedVersionReading::UnreadableReply(_) => None,
    }
}

// What the account's process reported of `connector` through `row`: the row's reading and error
// text through the one status mapping, and its tools; `None` for a row the mapping refused.
fn read_connector_reading(
    connector: &ClaudeMcpServer,
    row: &ClaudeMcpServerStatusRow,
    emissions: &[McpServerStatusEmission],
) -> Option<McpProbeReading> {
    let emission = emissions
        .iter()
        .find(|emission| Some(emission.server_name.as_str()) == row.name.as_deref())?;
    Some(McpProbeReading {
        binding: connector.binding.clone(),
        reading: emission.reading,
        failure_text: emission.failure_text.clone(),
        tool_names: row.tool_names(),
    })
}

// A `claudeai` row as the account's connector, reached at its own address and marked as `marks`
// reads its id; `None` for a row with no name the wire carries or no address.
fn read_connector(
    provider_account_id: &ProviderAccountId,
    row: &ClaudeMcpServerStatusRow,
    marks: Option<&ClaudeConnectorMarks>,
) -> Option<ClaudeMcpServer> {
    let server_name = McpServerName::new(row.name.clone()?).ok()?;
    let config = row.config.as_ref()?;
    let address = config.address.as_ref()?;
    let organization_managed = marks
        .zip(config.connector_id.as_deref())
        .and_then(|(marks, connector_id)| marks.mark(connector_id));
    let url_query_param_names =
        (!address.query_param_names.is_empty()).then(|| address.query_param_names.clone());
    Some(ClaudeMcpServer {
        binding: McpServerBindingRef::Connector {
            provider: DESCRIPTOR.provider_id(),
            scope_ref: provider_account_id.clone(),
            server_name,
        },
        config: remote_server_view("http", address.stripped_url.clone(), url_query_param_names)?,
        endpoint: address.identity.clone().map(ClaudeMcpEndpoint::Address),
        organization_managed,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::json;
    use serde_json::value::{RawValue, to_raw_value};
    use sidekicks_contracts::mcp::server::config::McpServerConfigView;
    use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerStatus};
    use sidekicks_platforms::{ProgramStart, Spawner};
    use tokio::runtime::Handle;

    use super::{
        ClaudeAccountServerAnswers, read_claude_account_answers, read_claude_account_servers,
    };
    use crate::driver::claude::mcp::config::ClaudeMcpConfigReading;
    use crate::driver::claude::mcp::precedence::rank_claude_mcp_servers;
    use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
    use crate::driver::claude::session::transport::control::{
        ClaudeControlRequest, ClaudeSettingsReply, ClaudeToolServerEntry,
    };
    use crate::driver::claude::session::transport::mcp_status::{
        ClaudeMcpServerStatus, ClaudeMcpStatusReply,
    };
    use crate::driver::claude::spawn::launch::ClaudeProcessLauncher;
    use crate::driver::claude::spawn::launch::control_only::{
        CLAUDE_CONTROL_ONLY_ARGUMENTS, ClaudeShortProcess,
    };
    use crate::driver::mcp_server::read::McpServerPolicy;
    use crate::driver::mcp_server::status::McpServerReading;
    use crate::process_registry::ProviderProcessRegistry;
    use crate::runtime_binding::test_store::test_provider_account_id;
    use crate::spawned_version::ResolvedProviderExecutable;

    // How long a probe waits for a server it hands over to report connected.
    const PROBE_CONNECT_DEADLINE: Duration = Duration::from_secs(60);

    fn raw(value: &serde_json::Value) -> Option<Box<RawValue>> {
        Some(to_raw_value(value).expect("a test reply serializes"))
    }

    fn remote_url(config: &McpServerConfigView) -> &str {
        match config {
            McpServerConfigView::Http { url, .. } | McpServerConfigView::Sse { url, .. } => url,
            McpServerConfigView::Stdio { .. } => panic!("a remote server: {config:?}"),
        }
    }

    // A `claudeai` row becomes a read-only connector of the account under its display name, read
    // with the status and tools its row reports, and the `managed` row and the
    // `managedMcpServers` entry read-only organization servers served with their host alone, the
    // entry kept whole only in the form a probe sends; the person's own `user` row is left to the
    // config read. Killed by a connector bound in a writable scope, by a connector's reading
    // dropped, by an organization address kept with its path or query, by a `managedMcpServers`
    // entry listed twice, and by its address or headers lost from the form a probe sends.
    #[test]
    fn an_accounts_rows_become_read_only_connectors_and_host_only_organization_servers() {
        let account = test_provider_account_id();
        let answers = ClaudeAccountServerAnswers {
            mcp_status: raw(&json!({
                "mcpServers": [
                    {
                        "name": "claude.ai Slack",
                        "status": "connected",
                        "scope": "claudeai",
                        "source": "claudeai",
                        "config": {
                            "type": "claudeai-proxy",
                            "url": "https://mcp.slack.example.com/mcp?team=t-secret",
                            "id": "connector-id-secret"
                        },
                        "tools": [{ "name": "send_message" }]
                    },
                    {
                        "name": "tracker",
                        "status": "pending",
                        "scope": "managed",
                        "config": { "type": "http", "url": "https://tracker.example.com:8443/v2" }
                    },
                    {
                        "name": "docs",
                        "status": "connected",
                        "scope": "managed",
                        "config": { "type": "http", "url": "https://docs.example.com" }
                    },
                    {
                        "name": "notes",
                        "status": "connected",
                        "scope": "user",
                        "config": { "type": "http", "url": "https://notes.example.com/mcp" }
                    }
                ]
            })),
            settings: raw(&json!({
                "effective": {
                    "managedMcpServers": {
                        "docs": {
                            "type": "sse",
                            "url": "https://docs.example.com/v1/sse?key=organization-secret",
                            "headers": { "Authorization": "Bearer header-secret" }
                        }
                    }
                }
            })),
            build_version: None,
        };

        let servers = read_claude_account_servers(&account, &answers, None);

        let [connector] = servers.connectors.as_slice() else {
            panic!("one connector: {:?}", servers.connectors);
        };
        let McpServerBindingRef::Connector {
            scope_ref,
            server_name,
            ..
        } = &connector.binding
        else {
            panic!("a connector binding: {:?}", connector.binding);
        };
        assert_eq!(scope_ref, &account);
        assert_eq!(server_name.as_str(), "claude.ai Slack");
        assert_eq!(
            remote_url(&connector.config),
            "https://mcp.slack.example.com/mcp"
        );
        let [reading] = servers.connector_readings.as_slice() else {
            panic!("one connector reading: {:?}", servers.connector_readings);
        };
        assert_eq!(reading.binding, connector.binding);
        assert_eq!(
            reading.reading,
            McpServerReading::Observed(McpServerStatus::Connected)
        );
        let tool_names: Vec<&str> = reading
            .tool_names
            .iter()
            .map(|name| name.as_str())
            .collect();
        assert_eq!(tool_names, ["send_message"]);
        let sendable: Vec<(&str, &ClaudeToolServerEntry)> = servers
            .organization_entries
            .iter()
            .map(|(name, entry)| (name.as_str(), entry))
            .collect();
        assert_eq!(
            sendable,
            [(
                "docs",
                &ClaudeToolServerEntry::Sse {
                    url: "https://docs.example.com/v1/sse?key=organization-secret".to_owned(),
                    headers: [(
                        "Authorization".to_owned(),
                        "Bearer header-secret".to_owned()
                    )]
                    .into(),
                }
            )]
        );
        let organization: Vec<(&str, &str)> = servers
            .organization_servers
            .iter()
            .map(|server| {
                let McpServerBindingRef::Managed { server_name, .. } = &server.binding else {
                    panic!("a managed binding: {:?}", server.binding);
                };
                (server_name.as_str(), remote_url(&server.config))
            })
            .collect();
        assert_eq!(
            organization,
            [
                ("docs", "docs.example.com"),
                ("tracker", "tracker.example.com:8443")
            ]
        );
        assert!(matches!(
            servers.organization_servers[0].config,
            McpServerConfigView::Sse { .. }
        ));
        let debug = format!(
            "{:?} {:?}",
            servers.connectors, servers.organization_servers
        );
        for secret in [
            "t-secret",
            "connector-id-secret",
            "/v2",
            "/v1/sse",
            "organization-secret",
            "header-secret",
        ] {
            assert!(!debug.contains(secret), "{secret} is kept: {debug}");
        }

        let reading = ClaudeMcpConfigReading {
            user_servers: Vec::new(),
            plugin_servers: Vec::new(),
            roots: Vec::new(),
            server_policy: McpServerPolicy::default(),
        };
        let ranking = rank_claude_mcp_servers(&reading, &[servers], false);
        let [account_servers] = ranking.account_servers.as_slice() else {
            panic!("one account: {:?}", ranking.account_servers);
        };
        assert_eq!(account_servers.declarations.len(), 3);
        assert!(
            account_servers
                .declarations
                .iter()
                .all(|declaration| declaration.is_read_only)
        );
    }

    // A real Claude Code on a claude.ai subscription login, checked for what the account read
    // and a session's hand-over rely on: (1) a connector handed over as a `claudeai-proxy` entry
    // under `--strict-mcp-config` connects with its tools; (2) an organization server sent with
    // `mcp_set_servers` connects where managed settings allow only the managed servers; (3) the
    // read's process reports the account's connectors and the organization's servers and no
    // server of the person's. The managed settings of (2) ride `--managed-settings`, and its
    // server is the one `SIDEKICKS_TEST_CLAUDE_ORGANIZATION_SERVER` names.
    #[tokio::test]
    #[ignore = "needs an installed Claude Code, a home signed in to claude.ai with a connector, and \
                a reachable MCP server"]
    async fn a_real_claude_code_reports_and_loads_connectors_and_organization_servers() {
        let program = PathBuf::from(
            std::env::var_os("SIDEKICKS_TEST_CLAUDE_PROGRAM")
                .expect("SIDEKICKS_TEST_CLAUDE_PROGRAM names the installed Claude Code program"),
        );
        let home =
            PathBuf::from(std::env::var_os("SIDEKICKS_TEST_CLAUDE_HOME").expect(
                "SIDEKICKS_TEST_CLAUDE_HOME names a Claude Code home signed in to claude.ai",
            ));
        let organization_url = std::env::var("SIDEKICKS_TEST_CLAUDE_ORGANIZATION_SERVER")
            .expect("SIDEKICKS_TEST_CLAUDE_ORGANIZATION_SERVER names a reachable MCP server");
        let folder = tempfile::tempdir().expect("a test folder");
        let launcher = ClaudeProcessLauncher::new(
            Spawner::new(Handle::current()).expect("a spawner"),
            Arc::new(ProviderProcessRegistry::default()),
            folder.path(),
        );
        let mut environment: Vec<(String, String)> = std::env::vars()
            .filter(|(name, _value)| name != "CLAUDE_CONFIG_DIR")
            .collect();
        environment.push((
            "CLAUDE_CONFIG_DIR".to_owned(),
            home.to_string_lossy().into_owned(),
        ));
        let executable = ResolvedProviderExecutable {
            requested_command: "claude".to_owned(),
            resolved_executable_path: program.clone(),
            start: ProgramStart {
                program,
                leading_arguments: Vec::new(),
            },
            environment,
        };
        let account = test_provider_account_id();

        // (3) The read's own process.
        let answers = read_claude_account_answers(
            &launcher,
            &executable,
            account.clone(),
            folder.path().join("account-read"),
        )
        .await
        .expect("the account read answers");
        let rows = ClaudeMcpStatusReply::read(answers.mcp_status.as_deref())
            .servers
            .expect("the read lists its servers")
            .0;
        for row in &rows {
            let origin = row.source.as_deref().or(row.scope.as_deref());
            assert!(
                matches!(origin, Some("claudeai" | "managed" | "enterprise")),
                "the read started a server of the person's: {row:?}"
            );
        }
        let effective = ClaudeSettingsReply::read(answers.settings.as_deref()).effective;
        let managed_names = effective
            .as_ref()
            .and_then(|settings| settings.get("managedMcpServers"))
            .and_then(serde_json::Value::as_object)
            .map(|servers| servers.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for name in &managed_names {
            assert!(
                rows.iter()
                    .any(|row| row.name.as_deref() == Some(name.as_str())),
                "the organization server {name} is not reported"
            );
        }
        let status: serde_json::Value = serde_json::from_str(
            answers
                .mcp_status
                .as_deref()
                .expect("the read answers mcp_status")
                .get(),
        )
        .expect("the answer is JSON");
        let connector = status["mcpServers"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|row| row["scope"] == "claudeai")
            .expect("the account reports a connector")
            .clone();
        assert!(
            !read_claude_account_servers(&account, &answers, None)
                .connectors
                .is_empty()
        );

        // (1) The connector handed over under `--strict-mcp-config`.
        let connector_name = connector["name"].as_str().expect("the connector is named");
        let mcp_config = json!({ "mcpServers": { connector_name: {
            "type": "claudeai-proxy",
            "url": connector["config"]["url"],
            "id": connector["config"]["id"],
        } } });
        let handed_over = start_probe(
            &launcher,
            &executable,
            folder.path().join("connector-probe"),
            &["--mcp-config".to_owned(), mcp_config.to_string()],
        )
        .await;
        wait_for_connected(&handed_over, connector_name).await;
        handed_over.close().await;

        // (2) The organization server sent with `mcp_set_servers`.
        let managed_settings = json!({
            "allowedMcpServers": [],
            "allowManagedMcpServersOnly": true,
            "managedMcpServers": {
                "probe-organization": { "type": "http", "url": organization_url },
            },
        });
        let sent = start_probe(
            &launcher,
            &executable,
            folder.path().join("organization-probe"),
            &[
                "--managed-settings".to_owned(),
                managed_settings.to_string(),
            ],
        )
        .await;
        sent.process
            .send_control_request(ClaudeControlRequest::McpSetServers {
                servers: [(
                    "probe-organization".to_owned(),
                    ClaudeToolServerEntry::Http {
                        url: organization_url.clone(),
                        headers: BTreeMap::new(),
                    },
                )]
                .into(),
            })
            .await
            .expect("mcp_set_servers is answered");
        wait_for_connected(&sent, "probe-organization").await;
        sent.close().await;
    }

    // A process that keeps nothing under `--strict-mcp-config` with `extra` arguments, initialized.
    async fn start_probe(
        launcher: &ClaudeProcessLauncher,
        executable: &ResolvedProviderExecutable,
        working_folder: PathBuf,
        extra: &[String],
    ) -> ClaudeShortProcess {
        tokio::fs::create_dir_all(&working_folder)
            .await
            .expect("the probe's folder is made");
        let arguments = CLAUDE_CONTROL_ONLY_ARGUMENTS
            .into_iter()
            .map(str::to_owned)
            .chain(["--strict-mcp-config".to_owned()])
            .chain(extra.iter().cloned())
            .collect();
        let short = ClaudeShortProcess::start(
            launcher,
            executable,
            arguments,
            working_folder,
            Some(test_provider_account_id()),
        )
        .await
        .expect("the probe starts");
        short.initialize().await.expect("the probe initializes");
        short
    }

    // Reads `mcp_status` until `name` reports connected with its tools, within the deadline.
    async fn wait_for_connected(short: &ClaudeShortProcess, name: &str) {
        let reads = async {
            loop {
                let answer = short
                    .process
                    .send_control_request(ClaudeControlRequest::McpStatus {})
                    .await
                    .expect("mcp_status is answered");
                let reply = ClaudeMcpStatusReply::read(answer.response.as_deref());
                let is_connected = reply.servers.iter().flat_map(|rows| &rows.0).any(|row| {
                    row.name.as_deref() == Some(name)
                        && row.status == Some(ClaudeMcpServerStatus::Connected)
                        && row.tools.as_ref().is_some_and(|tools| !tools.0.is_empty())
                });
                if is_connected {
                    return;
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        };
        tokio::time::timeout(PROBE_CONNECT_DEADLINE, reads)
            .await
            .unwrap_or_else(|_elapsed| panic!("{name} did not connect with its tools"));
    }
}
