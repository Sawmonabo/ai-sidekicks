use std::time::Duration;

use rstest::rstest;
use serde_json::json;
use serde_json::value::{RawValue, to_raw_value};
use sidekicks_contracts::mcp::server::config::McpServerConfigView;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerStatus};
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_platforms::CredentialStore;

use super::{ClaudeAccountServerAnswers, read_claude_account_answers, read_claude_account_servers};
use crate::driver::claude::account_credentials::ClaudeSignInReader;
use crate::driver::claude::mcp::config::ClaudeMcpConfigReading;
use crate::driver::claude::mcp::connectors::list_fetch::ClaudeConnectorFetchSettings;
use crate::driver::claude::mcp::connectors::organization_mark::{
    ClaudeConnectorListReading, ClaudeOrganizationMarks, read_connector_list,
};
use crate::driver::claude::mcp::machine_probe::probe_ceiling;
use crate::driver::claude::mcp::precedence::rank_claude_mcp_servers;
use crate::driver::claude::session::scripted::channel::{ScriptedAnswer, ScriptedChannel};
use crate::driver::claude::session::transport::control::ClaudeToolServerEntry;
use crate::driver::claude::session::transport::mcp_status::ClaudeMcpStatusReply;
use crate::driver::mcp_server::read::McpServerPolicy;
use crate::driver::mcp_server::status::McpServerReading;
use crate::runtime_binding::test_store::test_provider_account_id;

mod real_claude_code;

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

// How the account read finds its connector list: read and holding `Listed`'s connectors, or
// through the account read's own marks, for a process whose stored sign-in is `sign_in`, with
// `variables` and a setting where named, and an API host Claude Code refuses, so no list is read.
#[derive(Clone, Copy, Debug)]
enum ConnectorFetch {
    Listed(&'static [&'static str]),
    Through {
        sign_in: StoredSignIn,
        variables: &'static [(&'static str, &'static str)],
        setting: Option<FetchSetting>,
    },
}

// The account's stored sign-in: none, one that cannot be read, or one granted `Scopes`.
#[derive(Clone, Copy, Debug)]
enum StoredSignIn {
    Absent,
    Unreadable,
    Scopes(&'static [&'static str]),
}

// A setting that bears on the fetch: a settings source that switches the connectors off, or an
// API key helper in the merged settings.
#[derive(Clone, Copy, Debug)]
enum FetchSetting {
    ConnectorsDisabled,
    ApiKeyHelper,
}

// The ceiling of an account read under Claude Code's default startup timeout.
const READ_CEILING: Duration = Duration::from_secs(35);

// A sign-in granted every scope the fetch needs.
const SIGNED_IN: StoredSignIn = StoredSignIn::Scopes(&["user:inference", "user:mcp_servers"]);

// A process signed in, with `variables` set.
const fn with_variables(variables: &'static [(&'static str, &'static str)]) -> ConnectorFetch {
    with_sign_in_and_variables(SIGNED_IN, variables)
}

// A process whose stored sign-in is `sign_in`, with `variables` set.
const fn with_sign_in_and_variables(
    sign_in: StoredSignIn,
    variables: &'static [(&'static str, &'static str)],
) -> ConnectorFetch {
    ConnectorFetch::Through {
        sign_in,
        variables,
        setting: None,
    }
}

// A process whose stored sign-in is `sign_in`, with no variable or setting of note.
const fn with_sign_in(sign_in: StoredSignIn) -> ConnectorFetch {
    ConnectorFetch::Through {
        sign_in,
        variables: &[],
        setting: None,
    }
}

// A process signed in, with `setting`.
const fn with_setting(setting: FetchSetting) -> ConnectorFetch {
    ConnectorFetch::Through {
        sign_in: SIGNED_IN,
        variables: &[],
        setting: Some(setting),
    }
}

// A server the account's process configures at a listed connector's address.
#[derive(Clone, Copy, Debug)]
enum ConfiguredServer {
    // A row of the reply named `name`, with `status`, at the connector `at`'s address.
    Row {
        at: &'static str,
        name: &'static str,
        status: &'static str,
    },
    // An organization's `managedMcpServers` entry at the connector `at`'s whole address, which its
    // `managed` row reports with `status`, cut to its origin.
    Organization {
        at: &'static str,
        status: &'static str,
    },
}

// While the account's connector list holds a connector the `mcp_status` reply lacks, `mcp_status`
// is asked again on the same process once a second; a reply that reaches the list settles the
// read, and so does a count that stops growing above none, while a count of none settles once
// Claude Code's fetch can have ended, and a read that settles short of the list is marked as
// lacking. Where Claude Code fetches a list the daemon could not read (an unreadable sign-in, a
// refused host, the environment's own token granted the list's scope), the read waits for a
// connector or the fetch's end and settles whole. A listed connector at the whole address of a
// server the process configures is one Claude Code suppresses, so it is not waited for, unless
// that server is a plugin's, switched off or waits for a sign-in. Killed by a reply settling while
// it grows, by a count above none asked again until the fetch ends, by a count of none settling
// before the fetch ends, by an unread list taken as fetched by no one or kept as short, by a
// credential claimed ahead of the sign-in where a socket's token, a remote session or a desktop
// app keeps it aside, by a blank key or socket read as set, by a suppressed connector counted as
// missing, the organization's included, and by a plugin's, a switched-off or a waiting server
// counted as suppressing one.
#[rstest]
#[case::grows_to_the_list(
    ConnectorFetch::Listed(&["Notes", "Mail"]),
    &[&[][..], &["Notes"][..], &["Notes", "Mail"][..]],
    &[][..],
    3,
    2,
    false
)]
#[case::stops_growing_above_none(
    ConnectorFetch::Listed(&["Notes", "Mail"]),
    &[&["Notes"][..], &["Notes"][..]],
    &[][..],
    2,
    1,
    true
)]
#[case::none_until_the_fetch_lists_one(
    ConnectorFetch::Listed(&["Notes"]),
    &[&[][..], &[][..], &["Notes"][..]],
    &[][..],
    3,
    1,
    false
)]
#[case::none_through_the_fetch(
    ConnectorFetch::Listed(&["Notes"]),
    &[&[][..]],
    &[][..],
    29,
    0,
    true
)]
#[case::unread_list_none_through_the_fetch(
    with_sign_in(SIGNED_IN),
    &[&[][..]],
    &[][..],
    29,
    0,
    false
)]
#[case::unreadable_sign_in_until_a_connector_shows(
    with_sign_in(StoredSignIn::Unreadable),
    &[&[][..], &[][..], &["Notes"][..], &["Notes"][..]],
    &[][..],
    4,
    1,
    false
)]
#[case::the_environments_token_granted_the_list_scope(
    with_sign_in_and_variables(StoredSignIn::Absent, &[
        ("CLAUDE_CODE_OAUTH_TOKEN", "token"),
        ("CLAUDE_CODE_OAUTH_SCOPES", " user:inference  user:mcp_servers "),
    ]),
    &[&[][..]],
    &[][..],
    29,
    0,
    false
)]
#[case::unread_through_a_socket_with_a_token(
    with_variables(&[
        ("ANTHROPIC_UNIX_SOCKET", "/run/api.sock"),
        ("CLAUDE_CODE_OAUTH_TOKEN", "token"),
        ("CLAUDE_CODE_OAUTH_SCOPES", "user:inference user:mcp_servers"),
    ]),
    &[&[][..]],
    &[][..],
    29,
    0,
    false
)]
#[case::api_key_in_a_remote_session(
    with_variables(&[("ANTHROPIC_API_KEY", "key"), ("CLAUDE_CODE_REMOTE", "1")]),
    &[&[][..]],
    &[][..],
    29,
    0,
    false
)]
#[case::api_key_under_a_desktop_app(
    with_variables(&[("ANTHROPIC_API_KEY", "key"), ("CLAUDE_CODE_ENTRYPOINT", "claude-desktop")]),
    &[&[][..]],
    &[][..],
    29,
    0,
    false
)]
#[case::a_blank_api_key(
    with_variables(&[("ANTHROPIC_API_KEY", "  ")]),
    &[&[][..]],
    &[][..],
    29,
    0,
    false
)]
#[case::a_blank_socket(
    with_variables(&[("ANTHROPIC_UNIX_SOCKET", " ")]),
    &[&[][..]],
    &[][..],
    29,
    0,
    false
)]
#[case::duplicate_of_a_configured_server(
    ConnectorFetch::Listed(&["Notes", "Mail"]),
    &[&["Mail"][..]],
    &[ConfiguredServer::Row { at: "Notes", name: "notes", status: "connected" }][..],
    1,
    2,
    false
)]
#[case::duplicate_of_a_server_awaiting_sign_in(
    ConnectorFetch::Listed(&["Notes", "Mail"]),
    &[&["Mail"][..], &["Mail", "Notes"][..]],
    &[ConfiguredServer::Row { at: "Notes", name: "notes", status: "needs-auth" }][..],
    2,
    3,
    false
)]
#[case::duplicate_of_a_plugin_server(
    ConnectorFetch::Listed(&["Notes", "Mail"]),
    &[&["Mail"][..], &["Mail", "Notes"][..]],
    &[ConfiguredServer::Row { at: "Notes", name: "plugin:tools:notes", status: "connected" }][..],
    2,
    3,
    false
)]
#[case::duplicate_of_an_organization_server(
    ConnectorFetch::Listed(&["Notes", "Mail"]),
    &[&["Mail"][..]],
    &[ConfiguredServer::Organization { at: "Notes", status: "connected" }][..],
    1,
    2,
    false
)]
#[case::duplicate_of_a_switched_off_organization_server(
    ConnectorFetch::Listed(&["Notes", "Mail"]),
    &[&["Mail"][..], &["Mail", "Notes"][..]],
    &[ConfiguredServer::Organization { at: "Notes", status: "disabled" }][..],
    2,
    3,
    false
)]
#[case::duplicate_of_an_organization_server_awaiting_sign_in(
    ConnectorFetch::Listed(&["Notes", "Mail"]),
    &[&["Mail"][..], &["Mail", "Notes"][..]],
    &[ConfiguredServer::Organization { at: "Notes", status: "needs-auth" }][..],
    2,
    3,
    false
)]
#[tokio::test(start_paused = true)]
async fn mcp_status_is_asked_again_only_while_it_grows_toward_the_connector_list(
    #[case] fetch: ConnectorFetch,
    #[case] replies: &[&[&str]],
    #[case] configured: &[ConfiguredServer],
    #[case] status_reads: usize,
    #[case] kept_rows: usize,
    #[case] lacks_listed_connectors: bool,
) {
    let (asked, answers) = read_account_answers(fetch, replies, configured, READ_CEILING).await;

    assert_eq!(asked, status_reads);
    let kept = answers
        .mcp_status
        .servers
        .as_ref()
        .map_or(0, |rows| rows.0.len());
    assert_eq!(kept, kept_rows);
    assert_eq!(answers.lacks_listed_connectors, lacks_listed_connectors);
}

// Where the account's Claude Code fetches no connector list, the list is not read and the first
// reply settles the read whole: its connectors switched off by the variable or a settings source,
// safe mode, another provider or a gateway, bare mode, a socket with no token, a credential ahead
// of the sign-in, a key's file descriptor among them, no sign-in, or one short of a scope the
// fetch needs, the environment's token and a file descriptor's with the scopes Claude Code gives
// them. Killed by any of these not read, which leaves the read waiting for the fetch's end.
#[rstest]
#[case::no_sign_in(with_sign_in(StoredSignIn::Absent))]
#[case::connectors_switched_off(with_variables(&[("ENABLE_CLAUDEAI_MCP_SERVERS", " Off ")]))]
#[case::connectors_disabled_by_a_setting(with_setting(FetchSetting::ConnectorsDisabled))]
#[case::safe_mode(with_variables(&[("CLAUDE_CODE_SAFE_MODE", "1")]))]
#[case::another_provider(with_variables(&[("CLAUDE_CODE_USE_VERTEX", " TRUE ")]))]
#[case::bare_mode(with_variables(&[("CLAUDE_CODE_SIMPLE", "yes")]))]
#[case::a_socket_with_no_token(with_variables(&[("ANTHROPIC_UNIX_SOCKET", "/run/api.sock")]))]
#[case::an_auth_token_ahead(with_variables(&[("ANTHROPIC_AUTH_TOKEN", "token")]))]
#[case::an_api_key_ahead(with_variables(&[("ANTHROPIC_API_KEY", "key")]))]
#[case::an_api_key_helper_ahead(with_setting(FetchSetting::ApiKeyHelper))]
#[case::a_sign_in_short_of_inference(with_sign_in(StoredSignIn::Scopes(&["user:mcp_servers"])))]
#[case::a_sign_in_short_of_the_list_scope(with_sign_in(StoredSignIn::Scopes(&["user:inference"])))]
#[case::a_gateway(with_variables(&[
    ("CLAUDE_CODE_USE_GATEWAY", "1"),
    ("ANTHROPIC_BASE_URL", "https://gateway.example.com"),
    ("ANTHROPIC_AUTH_TOKEN", "token"),
    ("CLAUDE_CODE_REMOTE", "1"),
]))]
#[case::a_key_file_descriptor_ahead(
    with_variables(&[("CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR", "3")])
)]
#[case::the_environments_token_short_of_the_list_scope(
    with_variables(&[("CLAUDE_CODE_OAUTH_TOKEN", "token")])
)]
#[case::a_descriptor_token_short_of_the_list_scope(
    with_variables(&[("CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "3")])
)]
#[tokio::test(start_paused = true)]
async fn a_read_whose_claude_code_fetches_no_list_settles_whole_at_the_first_ask(
    #[case] fetch: ConnectorFetch,
) {
    let (asked, answers) = read_account_answers(fetch, &[&[]], &[], READ_CEILING).await;

    assert_eq!(asked, 1);
    assert!(!answers.lacks_listed_connectors);
}

// Under a short `MCP_TIMEOUT`, a list Claude Code fetches but the daemon could not read is still
// waited for until that fetch can have ended, and kept whole. Killed by the read stopping at the
// servers' own ceiling, 15 seconds.
#[tokio::test(start_paused = true)]
async fn a_short_mcp_timeout_still_waits_for_claude_codes_fetch() {
    let ceiling = probe_ceiling(&[("MCP_TIMEOUT".to_owned(), "10000".to_owned())]);

    let (asked, answers) =
        read_account_answers(with_sign_in(SIGNED_IN), &[&[]], &[], ceiling).await;

    assert_eq!(asked, 29);
    assert!(!answers.lacks_listed_connectors);
}

// The account read of an account whose list `fetch` finds, its process configuring `configured`
// and answering `replies` to `mcp_status` in turn, under `ceiling`: how many times it asked, and
// its answers.
async fn read_account_answers(
    fetch: ConnectorFetch,
    replies: &[&[&str]],
    configured: &[ConfiguredServer],
    ceiling: Duration,
) -> (usize, ClaudeAccountServerAnswers) {
    let address = |name: &str| format!("https://{}.example.com/mcp", name.to_lowercase());
    let channel = ScriptedChannel::default();
    channel.answer(
        "get_binary_version",
        ScriptedAnswer::Reply(json!({ "version": "2.1.310" })),
    );
    let mut managed_servers = serde_json::Map::new();
    let configured_rows: Vec<serde_json::Value> = configured
        .iter()
        .map(|server| match *server {
            ConfiguredServer::Row { at, name, status } => json!({
                "name": name,
                "status": status,
                "scope": "user",
                "config": { "type": "http", "url": format!("{}/", address(at)) }
            }),
            ConfiguredServer::Organization { at, status } => {
                let name = format!("org-{}", at.to_lowercase());
                managed_servers.insert(name.clone(), json!({ "type": "http", "url": address(at) }));
                json!({
                    "name": name,
                    "status": status,
                    "scope": "managed",
                    "config": {
                        "type": "http",
                        "url": format!("https://{}.example.com", at.to_lowercase())
                    }
                })
            }
        })
        .collect();
    let mut settings = json!({ "effective": { "managedMcpServers": managed_servers } });
    let home = tempfile::tempdir().expect("a test home");
    let mut environment = vec![
        (
            "CLAUDE_CONFIG_DIR".to_owned(),
            home.path().display().to_string(),
        ),
        ("USER".to_owned(), "tester".to_owned()),
        (
            "CLAUDE_CODE_CUSTOM_OAUTH_URL".to_owned(),
            "https://elsewhere.example.com".to_owned(),
        ),
    ];
    if let ConnectorFetch::Through {
        sign_in,
        variables,
        setting,
    } = fetch
    {
        let credentials = home.path().join(".credentials.json");
        match sign_in {
            StoredSignIn::Absent => {}
            StoredSignIn::Unreadable => {
                std::fs::create_dir(&credentials).expect("a folder stands in for the file");
            }
            StoredSignIn::Scopes(scopes) => std::fs::write(
                &credentials,
                json!({ "claudeAiOauth": { "accessToken": "token", "scopes": scopes } })
                    .to_string(),
            )
            .expect("the sign-in is planted"),
        }
        environment.extend(
            variables
                .iter()
                .map(|(name, value)| ((*name).to_owned(), (*value).to_owned())),
        );
        match setting {
            None => {}
            Some(FetchSetting::ConnectorsDisabled) => {
                settings["sources"] = json!([
                    { "source": "userSettings", "settings": { "model": "opus" } },
                    { "source": "localSettings", "settings": { "disableClaudeAiConnectors": true } }
                ]);
            }
            Some(FetchSetting::ApiKeyHelper) => {
                settings["effective"]["apiKeyHelper"] = json!("./print-key.sh");
            }
        }
    }
    channel.answer("get_settings", ScriptedAnswer::Reply(settings));
    for reply in replies {
        let rows: Vec<_> = reply
            .iter()
            .map(|name| connector_row(name))
            .chain(configured_rows.iter().cloned())
            .collect();
        channel.answer(
            "mcp_status",
            ScriptedAnswer::Reply(json!({ "mcpServers": rows })),
        );
    }
    let marks = ClaudeOrganizationMarks::new(ClaudeSignInReader::with_keychain(
        CredentialStore::in_memory(),
    ));

    let (answers, _marks) = read_claude_account_answers(
        &channel,
        async |build_version: Option<String>, settings: ClaudeConnectorFetchSettings| {
            assert_eq!(build_version.as_deref(), Some("2.1.310"));
            match fetch {
                ConnectorFetch::Listed(names) => {
                    let data: Vec<_> = names
                        .iter()
                        .map(|name| {
                            json!({
                                "id": format!("mcpsrv_{}", name.to_lowercase()),
                                "url": address(name)
                            })
                        })
                        .collect();
                    ClaudeConnectorListReading::Read(
                        read_connector_list(json!({ "data": data }).to_string().as_bytes())
                            .expect("the list reads"),
                    )
                }
                ConnectorFetch::Through { .. } => {
                    marks
                        .read(&environment, build_version.as_deref(), &settings)
                        .await
                }
            }
        },
        ceiling,
    )
    .await
    .expect("the read answers");
    let asked = channel
        .control_requests()
        .iter()
        .filter(|request| request["subtype"] == "mcp_status")
        .count();
    (asked, answers)
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
        plugin_roots: Vec::new(),
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
