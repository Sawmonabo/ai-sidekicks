use std::io::Write as _;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::http::header::CONTENT_ENCODING;
use axum::response::IntoResponse as _;
use flate2::Compression;
use flate2::write::GzEncoder;
use rstest::rstest;
use serde_json::json;
use serde_json::value::to_raw_value;
use sidekicks_contracts::mcp::server::McpServerBindingRef;
use sidekicks_platforms::CredentialStore;
use zeroize::Zeroizing;

use super::{ClaudeConnectorMarks, ClaudeOrganizationMarks};
use crate::driver::claude::account_credentials::{ClaudeAiSignIn, ClaudeSignInReader};
use crate::driver::claude::mcp::config::ClaudeMcpConfigReading;
use crate::driver::claude::mcp::connectors::{
    ClaudeAccountServerAnswers, read_claude_account_servers,
};
use crate::driver::claude::mcp::precedence::rank_claude_mcp_servers;
use crate::driver::mcp_server::read::McpServerPolicy;
use crate::runtime_binding::test_store::test_provider_account_id;

/// The list's first form, which asks for a connector's additional accounts too.
const LIST_WITH_ADDITIONAL_INSTALLS: &str =
    "/v1/mcp_servers?limit=1000&include_additional_installs=true";

/// The list's plain form, asked once more after a refusal.
const PLAIN_LIST: &str = "/v1/mcp_servers?limit=1000";

/// How far past its wait a retry may arrive on a busy test machine.
const WAIT_SLACK: Duration = Duration::from_millis(400);

// One request the loopback list received: its method, path and query, and every header but
// `host`, sorted by name.
#[derive(Debug, PartialEq)]
struct ReceivedRequest {
    method: String,
    path_and_query: String,
    headers: Vec<(String, String)>,
}

// How the loopback list answers one request: with a status and a body, or never, so the read's
// own time limit ends the try.
#[derive(Clone)]
enum ListAnswer {
    Reply(StatusCode, serde_json::Value),
    Gzipped(serde_json::Value),
    Hang,
}

// What the loopback list received, each request beside the moment it arrived.
#[derive(Default)]
struct ListLog {
    requests: Vec<ReceivedRequest>,
    arrivals: Vec<Instant>,
}

type SharedListLog = Arc<Mutex<ListLog>>;

// The loopback list's address and what it received.
struct LoopbackList {
    base: String,
    log: SharedListLog,
}

impl LoopbackList {
    fn paths(&self) -> Vec<String> {
        let log = self.log.lock().expect("not poisoned");
        log.requests
            .iter()
            .map(|request| request.path_and_query.clone())
            .collect()
    }

    // The time between each request and the next.
    fn gaps(&self) -> Vec<Duration> {
        let log = self.log.lock().expect("not poisoned");
        log.arrivals
            .windows(2)
            .map(|pair| pair[1] - pair[0])
            .collect()
    }
}

// A loopback list answering its requests by `script` in turn, its last answer repeated for every
// later request.
async fn serve_list(script: Vec<ListAnswer>) -> LoopbackList {
    let log = SharedListLog::default();
    let router = axum::Router::new()
        .fallback(move |State(log): State<SharedListLog>, request: Request| {
            let script = script.clone();
            async move {
                let arrived = Instant::now();
                let mut headers: Vec<(String, String)> = request
                    .headers()
                    .iter()
                    .filter(|(name, _value)| name.as_str() != "host")
                    .map(|(name, value)| {
                        (
                            name.as_str().to_owned(),
                            value.to_str().expect("a text header").to_owned(),
                        )
                    })
                    .collect();
                headers.sort();
                let answer = {
                    let mut log = log.lock().expect("not poisoned");
                    log.requests.push(ReceivedRequest {
                        method: request.method().as_str().to_owned(),
                        path_and_query: request
                            .uri()
                            .path_and_query()
                            .map(ToString::to_string)
                            .unwrap_or_default(),
                        headers,
                    });
                    log.arrivals.push(arrived);
                    let index = (log.requests.len() - 1).min(script.len() - 1);
                    script[index].clone()
                };
                match answer {
                    ListAnswer::Reply(status, body) => (status, body.to_string()).into_response(),
                    ListAnswer::Gzipped(body) => {
                        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
                        encoder
                            .write_all(body.to_string().as_bytes())
                            .expect("the reply compresses");
                        let compressed = encoder.finish().expect("the reply compresses");
                        (StatusCode::OK, [(CONTENT_ENCODING, "gzip")], compressed).into_response()
                    }
                    ListAnswer::Hang => std::future::pending().await,
                }
            }
        })
        .with_state(Arc::clone(&log));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a loopback port");
    let address = listener.local_addr().expect("the port's address");
    tokio::spawn(async move { axum::serve(listener, router).await });
    LoopbackList {
        base: format!("http://{address}"),
        log,
    }
}

// A loopback list answering every request with `status` and `body`.
async fn serve_answer(status: StatusCode, body: serde_json::Value) -> LoopbackList {
    serve_list(vec![ListAnswer::Reply(status, body)]).await
}

fn sign_in(scopes: &[&str]) -> ClaudeAiSignIn {
    ClaudeAiSignIn {
        access_token: Zeroizing::new("planted-access-token".to_owned()),
        scopes: scopes.iter().map(|scope| (*scope).to_owned()).collect(),
        refresh_token: None,
        expires_at: None,
        client_id: None,
    }
}

fn marks() -> ClaudeOrganizationMarks {
    ClaudeOrganizationMarks::new(ClaudeSignInReader::with_keychain(
        CredentialStore::in_memory(),
    ))
}

// The list is asked for with the line and the whole header set Claude Code sends, its user
// agent built from the build's version and its `Accept-Encoding` its HTTP library's own. Killed
// by any header dropped, renamed, added or given another value (the client's own
// `Accept-Encoding` among them), and by another path or query.
#[tokio::test]
async fn the_list_is_asked_for_with_exactly_claude_codes_headers() {
    let list = serve_answer(StatusCode::OK, json!({ "data": [] })).await;

    let read = marks()
        .read_list(
            &list.base,
            &sign_in(&["user:inference", "user:mcp_servers"]),
            "2.1.312",
        )
        .await;

    assert!(read.is_some());
    let expected = ReceivedRequest {
        method: "GET".to_owned(),
        path_and_query: LIST_WITH_ADDITIONAL_INSTALLS.to_owned(),
        headers: [
            ("accept", "application/json, text/plain, */*"),
            ("accept-encoding", "gzip, compress, deflate, br"),
            ("anthropic-beta", "mcp-servers-2025-12-04"),
            (
                "anthropic-mcp-client-capabilities",
                "eyJyb290cyI6eyJsaXN0Q2hhbmdlZCI6dHJ1ZX0sImVsaWNpdGF0aW9uIjp7fX0=",
            ),
            ("anthropic-version", "2023-06-01"),
            ("authorization", "Bearer planted-access-token"),
            ("content-type", "application/json"),
            ("mcp-protocol-version", "2025-11-25"),
            ("user-agent", "claude-code/2.1.312"),
        ]
        .into_iter()
        .map(|(name, value)| (name.to_owned(), value.to_owned()))
        .collect(),
    };
    assert_eq!(list.log.lock().expect("not poisoned").requests, [expected]);
}

// A token without the list's scope sends nothing. Killed by a read that asks anyway.
#[tokio::test]
async fn a_token_without_the_lists_scope_sends_no_request() {
    let list = serve_answer(StatusCode::OK, json!({ "data": [] })).await;

    let read = marks()
        .read_list(&list.base, &sign_in(&["user:inference"]), "2.1.312")
        .await;

    assert!(read.is_none());
    assert_eq!(list.paths(), [] as [String; 0]);
}

// The list marks a connector row by its normalized id, an `mcprs` entry matching the row's
// `mcpsrv` id, a later entry at the same address its sibling, and leaves a connector the list
// lacks absent, through the declaration the read hands on. Killed by a raw id compare, and by
// `false` where absent belongs.
#[tokio::test]
async fn the_list_marks_each_connector_by_its_normalized_id() {
    let list = serve_answer(
        StatusCode::OK,
        json!({ "data": [
            {
                "id": "mcprs_slack",
                "url": "https://mcp.slack.example.com/mcp",
                "display_name": "Slack",
                "enterprise_managed": true
            },
            {
                "id": "mcpsrv_slack_sibling",
                "url": "https://mcp.slack.example.com/mcp/",
                "enterprise_managed": false
            },
            {
                "id": "mcpsrv_notes",
                "url": "https://notes.example.com/mcp",
                "enterprise_managed": false
            }
        ] }),
    )
    .await;
    let read = marks()
        .read_list(&list.base, &sign_in(&["user:mcp_servers"]), "2.1.312")
        .await
        .expect("the list is read");
    assert_eq!(read.mark("mcpsrv_slack_sibling"), Some(true));
    let row = |name: &str, id: &str, url: &str| {
        json!({
            "name": name,
            "status": "connected",
            "scope": "claudeai",
            "source": "claudeai",
            "config": { "type": "claudeai-proxy", "url": url, "id": id }
        })
    };
    let answers = ClaudeAccountServerAnswers {
        mcp_status: Some(
            to_raw_value(&json!({ "mcpServers": [
                row("claude.ai Slack", "mcpsrv_slack", "https://mcp.slack.example.com/mcp"),
                row("claude.ai Notes", "mcpsrv_notes", "https://notes.example.com/mcp"),
                row("claude.ai Calendar", "mcpsrv_calendar", "https://cal.example.com/mcp"),
            ] }))
            .expect("a test reply serializes"),
        ),
        settings: None,
        build_version: Some("2.1.312".to_owned()),
    };
    let account = test_provider_account_id();

    let servers = read_claude_account_servers(&account, &answers, Some(&read));
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
    let mut marked: Vec<(&str, Option<bool>)> = account_servers
        .declarations
        .iter()
        .map(|declaration| {
            let McpServerBindingRef::Connector { server_name, .. } = &declaration.binding else {
                panic!("a connector: {:?}", declaration.binding);
            };
            (server_name.as_str(), declaration.organization_managed)
        })
        .collect();
    marked.sort_unstable();
    assert_eq!(
        marked,
        [
            ("claude.ai Calendar", None),
            ("claude.ai Notes", Some(false)),
            ("claude.ai Slack", Some(true)),
        ]
    );
}

// A reply the service compresses, as it may since the request asks for compression, is decoded
// before it is read. Killed by the reply read undecoded, which leaves the marks absent.
#[tokio::test]
async fn a_gzipped_list_is_decoded() {
    let list = serve_list(vec![ListAnswer::Gzipped(json!({ "data": [{
        "id": "mcpsrv_slack",
        "url": "https://mcp.slack.example.com/mcp",
        "enterprise_managed": true
    }] }))])
    .await;

    let read = read_marks(&list)
        .await
        .expect("the compressed list is read");

    assert_eq!(read.mark("mcpsrv_slack"), Some(true));
}

// The list read with a sign-in that holds its scope, as Claude Code 2.1.312.
async fn read_marks(list: &LoopbackList) -> Option<ClaudeConnectorMarks> {
    marks()
        .read_list(&list.base, &sign_in(&["user:mcp_servers"]), "2.1.312")
        .await
}

// A list that keeps failing with a server error is asked three times, 500 ms and then 1.5 s
// apart, then once more at once in its plain form, and the marks stay absent. Killed by a fourth
// counted try, by another wait, and by the plain form skipped or counted as a fourth try.
#[tokio::test]
async fn a_server_error_gets_three_tries_with_claude_codes_waits_then_the_plain_form() {
    let list = serve_answer(StatusCode::SERVICE_UNAVAILABLE, json!({})).await;

    let read = read_marks(&list).await;

    assert!(read.is_none());
    assert_eq!(
        list.paths(),
        [
            LIST_WITH_ADDITIONAL_INSTALLS,
            LIST_WITH_ADDITIONAL_INSTALLS,
            LIST_WITH_ADDITIONAL_INSTALLS,
            PLAIN_LIST,
        ]
    );
    let gaps = list.gaps();
    let waits = [
        Duration::from_millis(500),
        Duration::from_millis(1500),
        Duration::ZERO,
    ];
    assert_eq!(gaps.len(), waits.len(), "{gaps:?}");
    for (gap, wait) in gaps.iter().zip(waits) {
        assert!(*gap >= wait && *gap < wait + WAIT_SLACK, "{gaps:?}");
    }
}

// A try that times out after a server error leaves no room in the twelve-second budget for a
// third (5.5 s spent, 1.5 s to wait and 5 s to try), and a timeout has no status for the plain
// form, so the read ends after two tries. Killed by the budget ignored, which asks a third time.
#[tokio::test]
async fn a_timeout_after_a_server_error_ends_the_read_when_the_budget_has_no_room() {
    let list = serve_list(vec![
        ListAnswer::Reply(StatusCode::SERVICE_UNAVAILABLE, json!({})),
        ListAnswer::Hang,
    ])
    .await;
    let began = Instant::now();

    let read = read_marks(&list).await;

    assert!(read.is_none());
    assert_eq!(
        list.paths(),
        [LIST_WITH_ADDITIONAL_INSTALLS, LIST_WITH_ADDITIONAL_INSTALLS]
    );
    // The first wait and the second try's five seconds were spent before the read ended.
    let spent = began.elapsed();
    assert!(spent >= Duration::from_millis(5500), "{spent:?}");
}

// A refusal other than 401 and 429 is asked once more in the plain form and is final after it; a
// 401 is final at once. Killed by the plain form skipped on a 403, by a 403 retried past it, and
// by a 401 asked again.
#[rstest]
#[case::forbidden(StatusCode::FORBIDDEN, &[LIST_WITH_ADDITIONAL_INSTALLS, PLAIN_LIST])]
#[case::unauthorized(StatusCode::UNAUTHORIZED, &[LIST_WITH_ADDITIONAL_INSTALLS])]
#[tokio::test]
async fn a_refusal_is_asked_in_the_plain_form_unless_the_token_was_refused(
    #[case] status: StatusCode,
    #[case] asked: &[&str],
) {
    let list = serve_answer(status, json!({})).await;

    let read = read_marks(&list).await;

    assert!(read.is_none());
    assert_eq!(list.paths(), asked);
}

// A try that times out is tried again, and a list read on the second try marks its connectors.
// Killed by a timeout read as final, and by a later success dropped.
#[tokio::test]
async fn a_list_read_on_the_second_try_marks_its_connectors() {
    let list = serve_list(vec![
        ListAnswer::Hang,
        ListAnswer::Reply(
            StatusCode::OK,
            json!({ "data": [{
                "id": "mcprs_slack",
                "url": "https://mcp.slack.example.com/mcp",
                "enterprise_managed": true
            }] }),
        ),
    ])
    .await;

    let read = read_marks(&list).await.expect("the second try's list");

    assert_eq!(read.mark("mcpsrv_slack"), Some(true));
    assert_eq!(
        list.paths(),
        [LIST_WITH_ADDITIONAL_INSTALLS, LIST_WITH_ADDITIONAL_INSTALLS]
    );
}
