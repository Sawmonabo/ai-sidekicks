//! The account read of Claude Code's claude.ai connectors and its organization's servers: one
//! process that keeps nothing, started under the account without `--strict-mcp-config` in an
//! empty folder under the account's home, so nothing of the person's loads, answers
//! `get_binary_version`, `mcp_status` and `get_settings`, and each `claudeai` row becomes a
//! read-only connector of the account, with the status and tools the row reports, while the
//! organization's rows and `managedMcpServers` become read-only managed servers, each connector
//! marked as its organization's connector list reads it. Budget: one such process of about 140 to
//! 150 MB per account at a time, run at the account's first session after the daemon starts and
//! again only on a refresh, never on a poll; while it reports fewer connectors than the list
//! holds, less those Claude Code suppresses as duplicates of a configured server, and more than at
//! its last answer, one `mcp_status` a second on that process, up to the machine probe's ceiling.

pub(crate) mod organization_mark;

use std::future::Future;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::value::RawValue;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use tokio::time::Instant;

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
    ClaudeMcpServerStatus, ClaudeMcpServerStatusRow, ClaudeMcpStatusReply,
};
use crate::driver::claude::tools::normalize_claude_mcp_status_reply;
use crate::driver::claude::version::read_reported_version;
use crate::driver::mcp_server::address::ServerAddressIdentity;
use crate::driver::mcp_server::read::McpProbeReading;
use crate::driver::mcp_server::status::McpServerStatusEmission;

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

/// What one account's process answered: its `mcp_status` reply, read once, and its
/// `get_settings` reply unread, which can carry headers and whole addresses, so it lives only
/// until it is read.
pub(crate) struct ClaudeAccountServerAnswers {
    /// The `mcp_status` reply, read.
    pub(crate) mcp_status: ClaudeMcpStatusReply,
    /// The `get_settings` reply.
    pub(crate) settings: Option<Box<RawValue>>,
    /// Whether `mcp_status` still reported fewer connectors than the account's connector list
    /// holds when the read stopped asking, so Claude Code had not loaded them all yet.
    pub(crate) lacks_listed_connectors: bool,
}

/// How long the account read waits before asking `mcp_status` again while it reports fewer
/// connectors than the account's list holds.
const CONNECTOR_STATUS_INTERVAL: Duration = Duration::from_secs(1);

/// Reads one account's answers on `channel`, its process that keeps nothing already initialized:
/// the build's version, then the connector list `read_connector_list` reads for that version,
/// then `mcp_status`, asked again on the same process once a second until it reports as many
/// connectors as the list holds less those at the address of a server the reply shows configured,
/// reports as many as at its last answer, or `ceiling` passes, then `get_settings`. Where the list
/// is not read, `mcp_status` is asked once. Fails as a request does, a refused request included.
pub(crate) async fn read_claude_account_answers<ListRead>(
    channel: &dyn ClaudeProcessChannel,
    read_connector_list: impl FnOnce(Option<String>) -> ListRead,
    ceiling: Duration,
) -> Result<(ClaudeAccountServerAnswers, Option<ClaudeConnectorMarks>), ClaudeSessionError>
where
    ListRead: Future<Output = Option<ClaudeConnectorMarks>>,
{
    let deadline = Instant::now() + ceiling;
    let version = channel
        .send_control_request(ClaudeControlRequest::GetBinaryVersion {})
        .await?;
    let build_version = read_build_version(version.response.as_deref());
    let marks = read_connector_list(build_version).await;
    let mut last_reported_rows = None;
    let (mcp_status, reported_rows, listed_rows) = loop {
        let answer = channel
            .send_control_request(ClaudeControlRequest::McpStatus {})
            .await?;
        let reply = ClaudeMcpStatusReply::read(answer.response.as_deref());
        let reported_rows = count_connector_rows(&reply);
        let listed_rows = marks.as_ref().map_or(0, |marks| {
            marks.listed_row_count(&read_configured_addresses(&reply))
        });
        let now = Instant::now();
        // A reply no longer growing settles the read, so a connector Claude Code never lists
        // costs one more ask rather than the whole ceiling.
        if reported_rows >= listed_rows
            || last_reported_rows == Some(reported_rows)
            || now >= deadline
        {
            break (reply, reported_rows, listed_rows);
        }
        last_reported_rows = Some(reported_rows);
        tokio::time::sleep_until((now + CONNECTOR_STATUS_INTERVAL).min(deadline)).await;
    };
    let settings = channel
        .send_control_request(ClaudeControlRequest::GetSettings {})
        .await?;
    Ok((
        ClaudeAccountServerAnswers {
            mcp_status,
            settings: settings.response,
            lacks_listed_connectors: reported_rows < listed_rows,
        },
        marks,
    ))
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
    let reply = &answers.mcp_status;
    let emissions = normalize_claude_mcp_status_reply(reply)
        .map(|read| read.emissions)
        .unwrap_or_default();
    let rows = reply
        .servers
        .as_ref()
        .map(|rows| rows.0.as_slice())
        .unwrap_or_default();
    let settings = ClaudeSettingsReply::read(answers.settings.as_deref());
    let organization = read_claude_organization_servers(rows, settings.effective.as_ref());
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
        lacks_listed_connectors: answers.lacks_listed_connectors,
    }
}

// How many connectors an `mcp_status` reply reports.
fn count_connector_rows(reply: &ClaudeMcpStatusReply) -> usize {
    reply.servers.as_ref().map_or(0, |rows| {
        rows.0.iter().filter(|row| is_connector_row(row)).count()
    })
}

// The folded address of each server an `mcp_status` reply shows configured outside claude.ai and
// the plugins, which Claude Code matches its connectors against to suppress duplicates (`m$t`,
// b:21827999, as its print-mode caller passes them, b:28484035), less one switched off (`Io`,
// b:21855527) or waiting for a sign-in (`cRe` and `uoi`, b:12356518), which suppresses none.
fn read_configured_addresses(reply: &ClaudeMcpStatusReply) -> Vec<ServerAddressIdentity> {
    let rows = reply
        .servers
        .as_ref()
        .map_or(&[][..], |rows| rows.0.as_slice());
    rows.iter()
        .filter(|row| {
            !is_connector_row(row)
                && !row
                    .name
                    .as_deref()
                    .is_some_and(|name| name.starts_with("plugin:"))
                && !matches!(
                    row.status,
                    Some(ClaudeMcpServerStatus::Disabled | ClaudeMcpServerStatus::NeedsAuth)
                )
        })
        .filter_map(|row| row.config.as_ref()?.address.as_ref()?.identity.clone())
        .collect()
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
        tool_names: emission.tool_names.clone().unwrap_or_default(),
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

    use rstest::rstest;
    use serde_json::json;
    use serde_json::value::{RawValue, to_raw_value};
    use sidekicks_contracts::mcp::server::config::McpServerConfigView;
    use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerStatus};
    use sidekicks_contracts::wire::text::FreeFormText;
    use sidekicks_platforms::{ProgramStart, Spawner};
    use tokio::runtime::Handle;

    use super::{
        ClaudeAccountServerAnswers, read_claude_account_answers, read_claude_account_servers,
    };
    use crate::driver::claude::mcp::config::ClaudeMcpConfigReading;
    use crate::driver::claude::mcp::connectors::organization_mark::read_connector_list;
    use crate::driver::claude::mcp::precedence::rank_claude_mcp_servers;
    use crate::driver::claude::session::scripted::channel::{ScriptedAnswer, ScriptedChannel};
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

    fn raw(value: &serde_json::Value) -> Box<RawValue> {
        to_raw_value(value).expect("a test reply serializes")
    }

    fn remote_url(config: &McpServerConfigView) -> &str {
        match config {
            McpServerConfigView::Http { url, .. }
            | McpServerConfigView::Sse { url, .. }
            | McpServerConfigView::Ws { url, .. } => url,
            McpServerConfigView::Stdio { .. } => panic!("a remote server: {config:?}"),
        }
    }

    // The `claudeai` row of the connector `name`, as `mcp_status` reports it.
    fn connector_row(name: &str) -> serde_json::Value {
        json!({
            "name": format!("claude.ai {name}"),
            "status": "connected",
            "scope": "claudeai",
            "source": "claudeai",
            "config": {
                "type": "claudeai-proxy",
                "url": format!("https://{}.example.com/mcp", name.to_lowercase())
            }
        })
    }

    // While the account's connector list holds a connector the `mcp_status` reply lacks and the
    // reply grew since its last answer, `mcp_status` is asked again on the same process once a
    // second; a reply that reaches the list, or answers as many connectors as the last, settles
    // the read, a short one marked as lacking. A listed connector at the address of a server the
    // reply shows configured is one Claude Code suppresses, so it is not waited for. With no list
    // read, one reply is taken as it is. Killed by the reply asked once with a list read, by a
    // reply settling while it grows, by a reply that stops growing asked again until the ceiling,
    // and by a suppressed connector counted as missing.
    #[rstest]
    #[case::list_unread(None, &[&[][..], &["Notes"][..]], &[][..], 1, 0, false)]
    #[case::grows_to_the_list(
        Some(&["Notes", "Mail"][..]),
        &[&[][..], &["Notes"][..], &["Notes", "Mail"][..]],
        &[][..],
        3,
        2,
        false
    )]
    #[case::stops_growing(Some(&["Notes"][..]), &[&[][..], &[][..]], &[][..], 2, 0, true)]
    #[case::duplicate_of_a_configured_server(
        Some(&["Notes", "Mail"][..]),
        &[&["Mail"][..]],
        &["Notes"][..],
        1,
        2,
        false
    )]
    #[tokio::test(start_paused = true)]
    async fn mcp_status_is_asked_again_only_while_it_grows_toward_the_connector_list(
        #[case] listed: Option<&[&str]>,
        #[case] replies: &[&[&str]],
        #[case] configured: &[&str],
        #[case] status_reads: usize,
        #[case] kept_rows: usize,
        #[case] lacks_listed_connectors: bool,
    ) {
        let channel = ScriptedChannel::default();
        channel.answer(
            "get_binary_version",
            ScriptedAnswer::Reply(json!({ "version": "2.1.310" })),
        );
        for reply in replies {
            let configured_rows = configured.iter().map(|name| {
                json!({
                    "name": name.to_lowercase(),
                    "status": "connected",
                    "scope": "user",
                    "config": {
                        "type": "http",
                        "url": format!("https://{}.example.com/mcp/", name.to_lowercase())
                    }
                })
            });
            let rows: Vec<_> = reply
                .iter()
                .map(|name| connector_row(name))
                .chain(configured_rows)
                .collect();
            channel.answer(
                "mcp_status",
                ScriptedAnswer::Reply(json!({ "mcpServers": rows })),
            );
        }
        let list = listed.map(|names| {
            let data: Vec<_> = names
                .iter()
                .map(|name| {
                    json!({
                        "id": format!("mcpsrv_{}", name.to_lowercase()),
                        "url": format!("https://{}.example.com/mcp", name.to_lowercase())
                    })
                })
                .collect();
            json!({ "data": data }).to_string()
        });

        let (answers, _marks) = read_claude_account_answers(
            &channel,
            async |build_version: Option<String>| {
                assert_eq!(build_version.as_deref(), Some("2.1.310"));
                read_connector_list(list.as_ref()?.as_bytes())
            },
            Duration::from_secs(35),
        )
        .await
        .expect("the read answers");

        let asked = channel
            .control_requests()
            .iter()
            .filter(|request| request["subtype"] == "mcp_status")
            .count();
        assert_eq!(asked, status_reads);
        let kept = answers
            .mcp_status
            .servers
            .as_ref()
            .map_or(0, |rows| rows.0.len());
        assert_eq!(kept, kept_rows);
        assert_eq!(answers.lacks_listed_connectors, lacks_listed_connectors);
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
            mcp_status: ClaudeMcpStatusReply::read(Some(&raw(&json!({
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
            })))),
            settings: Some(raw(&json!({
                "effective": {
                    "managedMcpServers": {
                        "docs": {
                            "type": "sse",
                            "url": "https://docs.example.com/v1/sse?key=organization-secret",
                            "headers": { "Authorization": "Bearer header-secret" }
                        }
                    }
                }
            }))),
            lacks_listed_connectors: false,
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
            .map(FreeFormText::as_str)
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
        reading.initialize().await.expect("the read initializes");
        let (answers, _marks) = read_claude_account_answers(
            &*reading.process,
            async |_build_version| None,
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
