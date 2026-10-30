//! A real Claude Code checked for what the account read and a session's hand-over rely on.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use sidekicks_platforms::{ProgramStart, Spawner};
use tokio::runtime::Handle;

use crate::driver::claude::mcp::connectors::organization_mark::ClaudeConnectorListReading;
use crate::driver::claude::mcp::connectors::{
    read_claude_account_answers, read_claude_account_servers,
};
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
use crate::process_registry::ProviderProcessRegistry;
use crate::runtime_binding::test_store::test_provider_account_id;
use crate::spawned_version::ResolvedProviderExecutable;

// How long a probe waits for a server it hands over to report connected.
const PROBE_CONNECT_DEADLINE: Duration = Duration::from_secs(60);

// A real Claude Code on a claude.ai subscription login, checked for what the account read
// and a session's hand-over rely on: (1) a connector handed over as a `claudeai-proxy` entry
// under `--strict-mcp-config` connects with its tools; (2) an organization server sent with
// `mcp_set_servers` connects where managed settings allow only the managed servers; (3) the
// read's process reports the account's connectors and the organization's servers and no
// server of the person's. The managed settings of (2) ride `--managed-settings`, and its
// server is the one `SIDEKICKS_TEST_CLAUDE_ORGANIZATION_SERVER` names.
#[tokio::test]
#[ignore = "needs an installed Claude Code, a home signed in to claude.ai with a connector, \
            and a reachable MCP server"]
async fn a_real_claude_code_reports_and_loads_connectors_and_organization_servers() {
    let program = PathBuf::from(
        std::env::var_os("SIDEKICKS_TEST_CLAUDE_PROGRAM")
            .expect("SIDEKICKS_TEST_CLAUDE_PROGRAM names the installed Claude Code program"),
    );
    let home = PathBuf::from(
        std::env::var_os("SIDEKICKS_TEST_CLAUDE_HOME")
            .expect("SIDEKICKS_TEST_CLAUDE_HOME names a Claude Code home signed in to claude.ai"),
    );
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
    let read_folder = folder.path().join("account-read");
    tokio::fs::create_dir_all(&read_folder)
        .await
        .expect("the read's folder is made");
    let reading = ClaudeShortProcess::start_control_only(
        &launcher,
        &executable,
        Some(read_folder),
        None,
        Some(account.clone()),
    )
    .await
    .expect("the read's process starts");
    reading.initialize(&[]).await.expect("the read initializes");
    let (answers, _marks) = read_claude_account_answers(
        &*reading.process,
        async |_build_version, _settings| ClaudeConnectorListReading::Unread,
        Duration::from_secs(35),
    )
    .await
    .expect("the account read answers");
    let status_answer = reading
        .process
        .send_control_request(ClaudeControlRequest::McpStatus {})
        .await
        .expect("mcp_status is answered");
    reading.close().await;
    let rows = answers
        .mcp_status
        .servers
        .as_ref()
        .expect("the read lists its servers")
        .0
        .as_slice();
    for row in rows {
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
        status_answer
            .response
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
    short.initialize(&[]).await.expect("the probe initializes");
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
