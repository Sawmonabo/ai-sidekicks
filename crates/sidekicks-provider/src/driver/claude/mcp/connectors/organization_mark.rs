//! Whether an account's organization manages each of its claude.ai connectors: one read of the
//! account's connector list from claude.ai, sent exactly as Claude Code sends it at its own start
//! and only after the account's own Claude Code process answered, so that process has already
//! renewed an expiring token under its lock. The daemon renews nothing itself: a refused token
//! leaves every mark absent for that read. Budget: one request per account read, at most three
//! tries and one more without the additional accounts, within twelve seconds.

use std::collections::HashMap;
use std::time::Duration;

use base64::Engine;
use reqwest::StatusCode;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderValue, USER_AGENT};
use serde::Deserialize;
use sidekicks_platforms::PathRules;
use tokio::sync::OnceCell;
use tokio::time::Instant;
use zeroize::Zeroizing;

use super::{ClaudeAccountServerAnswers, lists_connectors};
use crate::driver::claude::account_credentials::{ClaudeAiSignIn, ClaudeSignInReader};
use crate::lenient_json::{LenientList, lenient_object, read_lenient};

/// Where Claude Code reads the connector list from unless its account names another approved host.
const CLAUDE_API_BASE: &str = "https://api.anthropic.com";

/// The hosts Claude Code accepts in `CLAUDE_CODE_CUSTOM_OAUTH_URL`, refusing any other.
const APPROVED_CUSTOM_BASES: [&str; 3] = [
    "https://beacon.claude-ai.staging.ant.dev",
    "https://claude.fedstart.com",
    "https://claude-staging.fedstart.com",
];

/// The variable that moves Claude Code's API host to an approved one.
const CUSTOM_BASE_VARIABLE: &str = "CLAUDE_CODE_CUSTOM_OAUTH_URL";

/// The connector list's path and query, the whole list in one page.
const CONNECTOR_LIST_PATH: &str = "/v1/mcp_servers?limit=1000";

/// The query Claude Code adds to list a connector's additional accounts too.
const ADDITIONAL_INSTALLS_QUERY: &str = "&include_additional_installs=true";

/// The scope a token needs for the connector list.
const CONNECTOR_LIST_SCOPE: &str = "user:mcp_servers";

/// The beta the connector list is served under.
const MCP_SERVERS_BETA: &str = "mcp-servers-2025-12-04";

/// The API version Claude Code names on the request.
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// The MCP client capabilities Claude Code declares on the request, before their base64.
const CLIENT_CAPABILITIES: &str = r#"{"roots":{"listChanged":true},"elicitation":{}}"#;

/// The MCP protocol version Claude Code declares on the request.
const MCP_PROTOCOL_VERSION: &str = "2025-11-25";

/// The `Accept` Claude Code's HTTP library sends on every request.
const ACCEPT_ANY_TEXT: &str = "application/json, text/plain, */*";

/// How long one try may take.
const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(5);

/// The tries a transient failure gets.
const TRANSIENT_ATTEMPTS: u32 = 3;

/// The wait before the first retry, tripled before each later one.
const RETRY_BASE_DELAY: Duration = Duration::from_millis(500);

/// The time every try and wait of one read fits in.
const RETRY_BUDGET: Duration = Duration::from_secs(12);

/// The idle connections the client keeps per host: the read sends one request at a time.
const IDLE_CONNECTIONS_PER_HOST: usize = 1;

/// Reads each account's connector list for its organization marks, with the account's sign-in.
pub(crate) struct ClaudeOrganizationMarks {
    sign_in: ClaudeSignInReader,
    http: OnceCell<reqwest::Client>,
}

/// The organization mark of each connector the list holds, by its normalized id.
pub(crate) struct ClaudeConnectorMarks {
    by_connector_id: HashMap<String, bool>,
}

impl ClaudeConnectorMarks {
    /// Whether the organization manages the connector `connector_id` names; `None` for a
    /// connector the list does not hold.
    pub(crate) fn mark(&self, connector_id: &str) -> Option<bool> {
        self.by_connector_id
            .get(&normalize_connector_id(connector_id))
            .copied()
    }
}

impl ClaudeOrganizationMarks {
    /// The marks read with the sign-in `sign_in` finds; the HTTP client is built at the first read.
    pub(crate) fn new(sign_in: ClaudeSignInReader) -> Self {
        Self {
            sign_in,
            http: OnceCell::new(),
        }
    }

    /// The marks of the connectors `answers` reports, read from the list of the account whose
    /// process `environment` started. `None`, with the reason logged at debug, where the answers
    /// report no connector or no build version, the account names a host Claude Code refuses, no
    /// sign-in with the list's scope is read, or the list cannot be read.
    pub(crate) async fn read(
        &self,
        environment: &[(String, String)],
        answers: &ClaudeAccountServerAnswers,
    ) -> Option<ClaudeConnectorMarks> {
        if !lists_connectors(answers) {
            return None;
        }
        let Some(build_version) = answers.build_version.as_deref() else {
            tracing::debug!(
                "no connector marks read: the account's Claude Code reported no version to send"
            );
            return None;
        };
        let base = claude_api_base(environment)?;
        let sign_in = self.sign_in.read(environment).await?;
        self.read_list(&base, &sign_in, build_version).await
    }

    // The marks of the list at `base`, read with `sign_in` as the build `build_version` reads it;
    // `None`, logged, where the token lacks the list's scope or the list is not read.
    async fn read_list(
        &self,
        base: &str,
        sign_in: &ClaudeAiSignIn,
        build_version: &str,
    ) -> Option<ClaudeConnectorMarks> {
        if !sign_in
            .scopes
            .iter()
            .any(|scope| scope == CONNECTOR_LIST_SCOPE)
        {
            tracing::debug!(
                "no connector marks read: the claude.ai sign-in lacks the connector list's scope"
            );
            return None;
        }
        let http = match self.http.get_or_try_init(build_http_client).await {
            Ok(http) => http,
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "no connector marks read: the HTTP client could not be built"
                );
                return None;
            }
        };
        let request = ConnectorListRequest::new(sign_in, build_version)?;
        let body = request.send_with_retries(http, base).await?;
        let list: ConnectorList = match serde_json::from_slice(&body) {
            Ok(list) => list,
            Err(error) => {
                tracing::debug!(
                    category = ?error.classify(),
                    "no connector marks read: the connector list is not a JSON object"
                );
                return None;
            }
        };
        Some(index_connector_marks(
            list.data.map(|entries| entries.0).unwrap_or_default(),
        ))
    }
}

// The client the list is read through: one idle connection, no decompression asked for, since
// the request names no `Accept-Encoding`.
async fn build_http_client() -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .pool_max_idle_per_host(IDLE_CONNECTIONS_PER_HOST)
        .no_gzip()
        .no_brotli()
        .no_zstd()
        .no_deflate()
        .build()
}

/// The API host the account's Claude Code reads its connector list from: its approved custom host,
/// its trailing `/` dropped, else the default. `None`, logged, where it names a host Claude Code
/// refuses.
pub(crate) fn claude_api_base(environment: &[(String, String)]) -> Option<String> {
    let Some(custom) = PathRules::NATIVE.environment_value(environment, CUSTOM_BASE_VARIABLE)
    else {
        return Some(CLAUDE_API_BASE.to_owned());
    };
    let custom = custom.strip_suffix('/').unwrap_or(custom);
    if APPROVED_CUSTOM_BASES.contains(&custom) {
        Some(custom.to_owned())
    } else {
        tracing::debug!(
            "no connector marks read: the account names an API host Claude Code refuses"
        );
        None
    }
}

// The request's header values, the token's held only until the read ends.
struct ConnectorListRequest {
    authorization: HeaderValue,
    user_agent: HeaderValue,
    client_capabilities: HeaderValue,
}

// One failed try: the status the list answered, or the transport's error.
enum AttemptFailure {
    Status(StatusCode),
    Transport(reqwest::Error),
}

impl AttemptFailure {
    fn status(&self) -> Option<StatusCode> {
        match self {
            Self::Status(status) => Some(*status),
            Self::Transport(error) => error.status(),
        }
    }

    // A server error, or a connection that failed, reset or ran out of time, as Claude Code
    // retries them.
    fn is_transient(&self) -> bool {
        match self {
            Self::Status(status) => status.is_server_error(),
            Self::Transport(error) => {
                error.is_timeout() || error.is_connect() || error.is_request()
            }
        }
    }
}

impl ConnectorListRequest {
    // The values for `sign_in` and `build_version`; `None`, logged, where a value is no header.
    fn new(sign_in: &ClaudeAiSignIn, build_version: &str) -> Option<Self> {
        let authorization = Zeroizing::new(format!("Bearer {}", sign_in.access_token.as_str()));
        let Ok(mut authorization) = HeaderValue::from_str(&authorization) else {
            tracing::debug!("no connector marks read: the access token is no header value");
            return None;
        };
        authorization.set_sensitive(true);
        let Ok(user_agent) = HeaderValue::from_str(&format!("claude-code/{build_version}")) else {
            tracing::debug!("no connector marks read: the build version is no header value");
            return None;
        };
        let client_capabilities = HeaderValue::from_str(
            &base64::engine::general_purpose::STANDARD.encode(CLIENT_CAPABILITIES),
        )
        .expect("base64 text is a header value");
        Some(Self {
            authorization,
            user_agent,
            client_capabilities,
        })
    }

    // The list's body, retried as Claude Code retries it: a transient failure up to three tries,
    // waiting 500 ms then 1.5 s within the twelve-second budget, and any status but 401 and 429
    // asked once more without the additional accounts, that try not counted unless transient.
    // `None`, logged once, where every try failed.
    async fn send_with_retries(&self, http: &reqwest::Client, base: &str) -> Option<bytes::Bytes> {
        let plain = format!("{base}{CONNECTOR_LIST_PATH}");
        let mut address = format!("{plain}{ADDITIONAL_INSTALLS_QUERY}");
        let started = Instant::now();
        let mut attempts: u32 = 0;
        let mut uncounted: u32 = 0;
        loop {
            attempts += 1;
            let failure = match self.send(http, &address).await {
                Ok(body) => return Some(body),
                Err(failure) => failure,
            };
            let counted = attempts - uncounted;
            let mut ask_plain = || {
                let status = failure.status()?;
                if address == plain
                    || status == StatusCode::UNAUTHORIZED
                    || status == StatusCode::TOO_MANY_REQUESTS
                {
                    return None;
                }
                tracing::debug!(
                    status = status.as_u16(),
                    "the connector list was refused; asking once more without a connector's \
                     additional accounts"
                );
                address.clone_from(&plain);
                if !failure.is_transient() {
                    uncounted += 1;
                }
                Some(())
            };
            if counted >= TRANSIENT_ATTEMPTS || !failure.is_transient() {
                if ask_plain().is_some() {
                    continue;
                }
                log_final_failure(&failure, attempts);
                return None;
            }
            let delay = RETRY_BASE_DELAY * 3_u32.pow(counted - 1);
            if started.elapsed() + delay + ATTEMPT_TIMEOUT >= RETRY_BUDGET {
                tracing::debug!(attempts, "the connector list's retry budget ran out");
                if ask_plain().is_some() {
                    continue;
                }
                log_final_failure(&failure, attempts);
                return None;
            }
            tracing::debug!(
                status = failure.status().map(|status| status.as_u16()),
                attempt = counted,
                delay_ms = u64::try_from(delay.as_millis()).unwrap_or(u64::MAX),
                "the connector list failed transiently; retrying"
            );
            tokio::time::sleep(delay).await;
        }
    }

    // One try at `address`, with exactly the headers Claude Code sends on it.
    async fn send(
        &self,
        http: &reqwest::Client,
        address: &str,
    ) -> Result<bytes::Bytes, AttemptFailure> {
        let response = http
            .get(address)
            .header(USER_AGENT, self.user_agent.clone())
            .header(AUTHORIZATION, self.authorization.clone())
            .header(CONTENT_TYPE, "application/json")
            .header("anthropic-beta", MCP_SERVERS_BETA)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header(
                "anthropic-mcp-client-capabilities",
                self.client_capabilities.clone(),
            )
            .header("MCP-Protocol-Version", MCP_PROTOCOL_VERSION)
            .header(ACCEPT, ACCEPT_ANY_TEXT)
            .timeout(ATTEMPT_TIMEOUT)
            .send()
            .await
            .map_err(AttemptFailure::Transport)?;
        let status = response.status();
        if !status.is_success() {
            return Err(AttemptFailure::Status(status));
        }
        response.bytes().await.map_err(AttemptFailure::Transport)
    }
}

// Logs the read's last failure once, a refused token's included.
fn log_final_failure(failure: &AttemptFailure, attempts: u32) {
    match failure {
        AttemptFailure::Status(status) => tracing::debug!(
            status = status.as_u16(),
            attempts,
            "no connector marks read: the connector list was refused"
        ),
        AttemptFailure::Transport(error) => tracing::debug!(
            error = error as &(dyn std::error::Error + 'static),
            attempts,
            "no connector marks read: the connector list could not be reached"
        ),
    }
}

// The connector list's body: its entries under `data`, every other member skipped.
#[derive(Deserialize)]
struct ConnectorList {
    #[serde(default, deserialize_with = "read_lenient")]
    data: Option<LenientList<ConnectorListEntry>>,
}

// One entry of the list, by the members its mark and its match need.
#[derive(Deserialize)]
struct ConnectorListEntry {
    #[serde(default, deserialize_with = "read_lenient")]
    id: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    url: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    enterprise_managed: Option<bool>,
    #[serde(default, deserialize_with = "read_lenient")]
    additional_install: Option<bool>,
}

lenient_object!(ConnectorListEntry);

// Each entry's mark by its normalized id, as Claude Code indexes its list: the first entry per
// normalized address is a row, a later one at that address its sibling read with the row's mark,
// and an additional account's entry a row of its own.
fn index_connector_marks(entries: Vec<ConnectorListEntry>) -> ClaudeConnectorMarks {
    let mut row_by_address: HashMap<String, bool> = HashMap::new();
    let mut by_connector_id: HashMap<String, bool> = HashMap::new();
    for entry in &entries {
        let mark = entry.enterprise_managed == Some(true);
        if entry.additional_install == Some(true) {
            if let Some(id) = &entry.id {
                by_connector_id.insert(normalize_connector_id(id), mark);
            }
            continue;
        }
        let address = entry.url.as_deref().map(normalize_connector_address);
        if let Some(address) = &address
            && row_by_address.contains_key(address)
        {
            continue;
        }
        if let Some(address) = address {
            row_by_address.insert(address, mark);
        }
        if let Some(id) = &entry.id {
            by_connector_id.insert(normalize_connector_id(id), mark);
        }
    }
    for entry in &entries {
        let Some(id) = &entry.id else { continue };
        let id = normalize_connector_id(id);
        if by_connector_id.contains_key(&id) {
            continue;
        }
        let row_mark = entry
            .url
            .as_deref()
            .map(normalize_connector_address)
            .and_then(|address| row_by_address.get(&address).copied());
        if let Some(mark) = row_mark {
            by_connector_id.insert(id, mark);
        }
    }
    ClaudeConnectorMarks { by_connector_id }
}

// A connector id as Claude Code compares it: an `mcprs` prefix read as `mcpsrv`.
fn normalize_connector_id(id: &str) -> String {
    match id.strip_prefix("mcprs") {
        Some(rest) => format!("mcpsrv{rest}"),
        None => id.to_owned(),
    }
}

// An address as Claude Code compares two entries' by: parsed and written back, its trailing `/`
// dropped; an address that does not parse compared as written.
fn normalize_connector_address(address: &str) -> String {
    url::Url::parse(address).map_or_else(
        |_unparsed| address.to_owned(),
        |parsed| parsed.as_str().trim_end_matches('/').to_owned(),
    )
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::extract::{Request, State};
    use axum::http::StatusCode;
    use serde_json::json;
    use serde_json::value::to_raw_value;
    use sidekicks_contracts::mcp::server::McpServerBindingRef;
    use sidekicks_platforms::CredentialStore;
    use zeroize::Zeroizing;

    use super::ClaudeOrganizationMarks;
    use crate::driver::claude::account_credentials::{ClaudeAiSignIn, ClaudeSignInReader};
    use crate::driver::claude::mcp::config::ClaudeMcpConfigReading;
    use crate::driver::claude::mcp::connectors::{
        ClaudeAccountServerAnswers, read_claude_account_servers,
    };
    use crate::driver::claude::mcp::precedence::rank_claude_mcp_servers;
    use crate::driver::mcp_server::read::McpServerPolicy;
    use crate::runtime_binding::test_store::test_provider_account_id;

    // One request the loopback list received: its method, path and query, and every header but
    // `host`, sorted by name.
    #[derive(Debug, PartialEq)]
    struct ReceivedRequest {
        method: String,
        path_and_query: String,
        headers: Vec<(String, String)>,
    }

    type ReceivedRequests = Arc<Mutex<Vec<ReceivedRequest>>>;

    // A loopback list answering every request with `status` and `body`, and what it received.
    async fn serve_list(status: StatusCode, body: serde_json::Value) -> (String, ReceivedRequests) {
        let received = ReceivedRequests::default();
        let router = axum::Router::new()
            .fallback(
                move |State(received): State<ReceivedRequests>, request: Request| {
                    let body = body.to_string();
                    async move {
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
                        received
                            .lock()
                            .expect("not poisoned")
                            .push(ReceivedRequest {
                                method: request.method().as_str().to_owned(),
                                path_and_query: request
                                    .uri()
                                    .path_and_query()
                                    .map(ToString::to_string)
                                    .unwrap_or_default(),
                                headers,
                            });
                        (status, body)
                    }
                },
            )
            .with_state(Arc::clone(&received));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a loopback port");
        let address = listener.local_addr().expect("the port's address");
        tokio::spawn(async move { axum::serve(listener, router).await });
        (format!("http://{address}"), received)
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
    // agent built from the build's version. Killed by any header dropped, renamed, added or given
    // another value, and by another path or query.
    #[tokio::test]
    async fn the_list_is_asked_for_with_exactly_claude_codes_headers() {
        let (base, received) = serve_list(StatusCode::OK, json!({ "data": [] })).await;

        let read = marks()
            .read_list(
                &base,
                &sign_in(&["user:inference", "user:mcp_servers"]),
                "2.1.312",
            )
            .await;

        assert!(read.is_some());
        let expected = ReceivedRequest {
            method: "GET".to_owned(),
            path_and_query: "/v1/mcp_servers?limit=1000&include_additional_installs=true"
                .to_owned(),
            headers: [
                ("accept", "application/json, text/plain, */*"),
                (
                    "anthropic-mcp-client-capabilities",
                    "eyJyb290cyI6eyJsaXN0Q2hhbmdlZCI6dHJ1ZX0sImVsaWNpdGF0aW9uIjp7fX0=",
                ),
                ("anthropic-beta", "mcp-servers-2025-12-04"),
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
        assert_eq!(*received.lock().expect("not poisoned"), [expected]);
    }

    // A token without the list's scope sends nothing. Killed by a read that asks anyway.
    #[tokio::test]
    async fn a_token_without_the_lists_scope_sends_no_request() {
        let (base, received) = serve_list(StatusCode::OK, json!({ "data": [] })).await;

        let read = marks()
            .read_list(&base, &sign_in(&["user:inference"]), "2.1.312")
            .await;

        assert!(read.is_none());
        assert!(received.lock().expect("not poisoned").is_empty());
    }

    // The list marks a connector row by its normalized id, an `mcprs` entry matching the row's
    // `mcpsrv` id, a later entry at the same address its sibling, and leaves a connector the list
    // lacks absent, through the declaration the read hands on. Killed by a raw id compare, and by
    // `false` where absent belongs.
    #[tokio::test]
    async fn the_list_marks_each_connector_by_its_normalized_id() {
        let (base, _received) = serve_list(
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
            .read_list(&base, &sign_in(&["user:mcp_servers"]), "2.1.312")
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
                let McpServerBindingRef::Connector { server_name, .. } = &declaration.binding
                else {
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
}
