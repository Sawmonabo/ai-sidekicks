//! The search of the public MCP Registry behind `Browse servers`: one GET per search the person
//! types, read within a time and size bound, and kept no longer than the page it answers.
//!
//! The registry is untrusted data anyone can publish to. A result keeps what fills the add form
//! and nothing else: no environment variable, header or address variable keeps a value or a
//! default, and a secret argument keeps neither. A remote whose address is a template is kept as
//! written only while each of its placeholders names one of its variables, so the form can ask for
//! every one.

use std::error::Error;
use std::time::Duration;

use reqwest::{StatusCode, Url};
use serde::Deserialize;
use serde_json::{Map, Value};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::mcp::server::requests::{
    McpRegistryInput, McpRegistryPackage, McpRegistryRemote, McpRegistrySearchRequest,
    McpRegistrySearchResponse, McpRegistryServer,
};
use sidekicks_contracts::web_address::WebAddress;
use sidekicks_contracts::wire::AnyValue;
use sidekicks_contracts::wire::record::JsonRecord;
use sidekicks_contracts::wire::text::{NonEmptyText, is_within_length};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_std::outbound_http::{CappedBodyError, KeptOutboundClient, read_capped_body};

/// The public MCP Registry the daemon searches.
pub const MCP_REGISTRY_ADDRESS: &str = "https://registry.modelcontextprotocol.io";

/// How long one search waits for the registry's whole reply, its body included.
pub const MCP_REGISTRY_SEARCH_TIMEOUT: Duration = Duration::from_secs(10);

/// The most bytes of a reply a search reads, in bytes.
pub const MCP_REGISTRY_REPLY_MAX_BYTES: usize = 256 * 1024;

/// The servers one search asks the registry for.
pub const MCP_REGISTRY_PAGE_SIZE: usize = 30;

/// The fewest code points, after trimming surrounding whitespace, a query the registry is sent
/// holds; the registry refuses a shorter one that is not empty.
pub const MCP_REGISTRY_MIN_QUERY_LENGTH: usize = 3;

/// The registry's list of servers, under its address.
const SERVERS_PATH: &str = "/v0.1/servers";

/// The idle connections the kept client holds to the registry.
const IDLE_CONNECTIONS_PER_HOST: usize = 1;

/// Why a search got no page from the registry.
#[derive(Debug, thiserror::Error)]
pub enum McpRegistrySearchError {
    /// The registry did not answer within [`MCP_REGISTRY_SEARCH_TIMEOUT`].
    #[error("the MCP Registry did not answer in time")]
    TimedOut(#[source] reqwest::Error),
    /// The registry could not be reached, redirected, answered with a failure, or answered with a
    /// page past the size bound or one that does not read.
    #[error("the MCP Registry could not be reached")]
    Unavailable(#[source] Box<dyn Error + Send + Sync>),
}

impl From<McpRegistrySearchError> for DomainError {
    /// A timeout answers `provider.timeout` and every other failure `provider.unavailable`, each
    /// in plain words naming no address, the failure underneath kept as the source.
    fn from(error: McpRegistrySearchError) -> Self {
        match error {
            McpRegistrySearchError::TimedOut(source) => DomainError::new(
                "The MCP Registry didn't answer in time.",
                RefusalCode::ProviderTimeout,
            )
            .with_source(source),
            McpRegistrySearchError::Unavailable(source) => DomainError::new(
                "The MCP Registry couldn't be reached.",
                RefusalCode::ProviderUnavailable,
            )
            .with_source(source),
        }
    }
}

/// The registry's answer with a status other than success, a redirect among them.
#[derive(Debug, thiserror::Error)]
#[error("the registry answered with status {0}")]
struct UnexpectedStatus(StatusCode);

/// The client that searches the registry at one address, keeping one HTTP client built on its
/// first search, which follows no redirect.
pub struct McpRegistryClient {
    /// The registry's address, with no path.
    address: String,
    /// The HTTP client, built on first use.
    client: KeptOutboundClient,
}

impl McpRegistryClient {
    /// A client of the registry at `address` (such as [`MCP_REGISTRY_ADDRESS`]); nothing is built
    /// or sent until the first search.
    pub fn new(address: &str) -> Self {
        Self {
            address: address.to_owned(),
            client: KeptOutboundClient::new(IDLE_CONNECTIONS_PER_HOST),
        }
    }

    /// One page of the registry's servers whose names hold `request`'s query, trimmed. A query
    /// under [`MCP_REGISTRY_MIN_QUERY_LENGTH`] code points answers no servers and sends nothing.
    /// Fails [`McpRegistrySearchError::TimedOut`] with no whole reply in time, and
    /// [`McpRegistrySearchError::Unavailable`] on any other failure.
    pub async fn search(
        &self,
        request: &McpRegistrySearchRequest,
    ) -> Result<McpRegistrySearchResponse, McpRegistrySearchError> {
        let query = request.query.as_str().trim();
        if !is_within_length(query, MCP_REGISTRY_MIN_QUERY_LENGTH, usize::MAX) {
            return Ok(McpRegistrySearchResponse {
                servers: Vec::new(),
                next_cursor: None,
            });
        }
        let mut target = Url::parse(&format!("{}{SERVERS_PATH}", self.address))
            .map_err(|error| McpRegistrySearchError::Unavailable(Box::new(error)))?;
        {
            let mut pairs = target.query_pairs_mut();
            pairs
                .append_pair("search", query)
                .append_pair("version", "latest")
                .append_pair("limit", &MCP_REGISTRY_PAGE_SIZE.to_string());
            if let Some(cursor) = &request.cursor {
                pairs.append_pair("cursor", cursor.as_str());
            }
        }
        let response = self
            .client
            .client()
            .map_err(|error| McpRegistrySearchError::Unavailable(Box::new(error)))?
            .get(target)
            .timeout(MCP_REGISTRY_SEARCH_TIMEOUT)
            .send()
            .await
            .map_err(request_failure)?;
        let status = response.status();
        if !status.is_success() {
            return Err(McpRegistrySearchError::Unavailable(Box::new(
                UnexpectedStatus(status),
            )));
        }
        let body = read_capped_body(response, MCP_REGISTRY_REPLY_MAX_BYTES)
            .await
            .map_err(|error| match error {
                CappedBodyError::Read(error) => request_failure(error),
                too_large @ CappedBodyError::TooLarge { .. } => {
                    McpRegistrySearchError::Unavailable(Box::new(too_large))
                }
            })?;
        let page: RegistryPage = serde_json::from_slice(&body)
            .map_err(|error| McpRegistrySearchError::Unavailable(Box::new(error)))?;
        Ok(McpRegistrySearchResponse {
            servers: page
                .servers
                .into_iter()
                .filter_map(registry_server)
                .collect(),
            next_cursor: page.metadata.next_cursor.and_then(NonEmptyText::new),
        })
    }
}

// A request's failure, its address dropped: a timeout as such, anything else as unavailable.
fn request_failure(error: reqwest::Error) -> McpRegistrySearchError {
    let error = error.without_url();
    if error.is_timeout() {
        McpRegistrySearchError::TimedOut(error)
    } else {
        McpRegistrySearchError::Unavailable(Box::new(error))
    }
}

/// One page as the registry writes it; unknown members are ignored and absent lists read empty.
#[derive(Deserialize)]
struct RegistryPage {
    /// Each listed server, read one by one so one that does not read leaves only itself out.
    #[serde(default)]
    servers: Vec<Value>,
    /// Where the next page starts.
    #[serde(default)]
    metadata: RegistryPageMetadata,
}

/// The page's own facts.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryPageMetadata {
    /// The cursor of the page after this one.
    next_cursor: Option<String>,
}

/// One listed server with the registry's own metadata beside it, which is not read.
#[derive(Deserialize)]
struct RegistryEntry {
    /// The server's record.
    server: ServerRecord,
}

/// A server's record.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerRecord {
    /// Its registry name.
    name: Option<String>,
    /// The name a person reads.
    title: Option<String>,
    /// What it does.
    description: Option<String>,
    /// Its version.
    version: Option<String>,
    /// The packages it runs as.
    #[serde(default)]
    packages: Vec<PackageRecord>,
    /// The addresses it is reached at.
    #[serde(default)]
    remotes: Vec<RemoteRecord>,
}

/// A package's record.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackageRecord {
    /// The package registry.
    registry_type: Option<String>,
    /// The package's name there.
    identifier: Option<String>,
    /// The package's version.
    version: Option<String>,
    /// The runtime that runs it.
    runtime_hint: Option<String>,
    /// The runtime's arguments.
    runtime_arguments: Option<Vec<Map<String, Value>>>,
    /// The package's own arguments.
    package_arguments: Option<Vec<Map<String, Value>>>,
    /// The environment variables it reads.
    #[serde(default)]
    environment_variables: Vec<InputRecord>,
}

/// A remote's record.
#[derive(Deserialize)]
struct RemoteRecord {
    /// How it is reached.
    #[serde(rename = "type")]
    transport: Option<String>,
    /// Its address or address template.
    url: Option<String>,
    /// The placeholders of its address, by name, in the registry's order.
    #[serde(default)]
    variables: Map<String, Value>,
    /// The headers its requests carry.
    #[serde(default)]
    headers: Vec<InputRecord>,
}

/// An input's record with only what the form asks by: its `value`, `default` and `variables` are
/// never read.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InputRecord {
    /// Its name; an address variable is named by its key instead.
    name: Option<String>,
    /// What it is for.
    description: Option<String>,
    /// Whether the server needs it.
    #[serde(default)]
    is_required: bool,
    /// Whether it is a secret.
    #[serde(default)]
    is_secret: bool,
}

// The contract's server from one listed entry, or `None` when it has no name, description or
// version.
fn registry_server(entry: Value) -> Option<McpRegistryServer> {
    let RegistryEntry { server } = serde_json::from_value(entry).ok()?;
    let mut environment_variables: Vec<McpRegistryInput> = Vec::new();
    let package_inputs = server
        .packages
        .iter()
        .flat_map(|package| &package.environment_variables);
    for input in package_inputs.filter_map(|record| registry_input(record.name.clone(), record)) {
        match environment_variables
            .iter_mut()
            .find(|gathered| gathered.name == input.name)
        {
            Some(gathered) => {
                gathered.is_required |= input.is_required;
                gathered.is_secret |= input.is_secret;
            }
            None => environment_variables.push(input),
        }
    }
    Some(McpRegistryServer {
        name: NonEmptyText::new(server.name?)?,
        title: server.title,
        description: server.description?,
        version: server.version?,
        packages: non_empty(
            server
                .packages
                .into_iter()
                .filter_map(registry_package)
                .collect(),
        ),
        remotes: non_empty(
            server
                .remotes
                .into_iter()
                .filter_map(registry_remote)
                .collect(),
        ),
        environment_variables,
    })
}

// The contract's package, or `None` when it names no registry or package.
fn registry_package(package: PackageRecord) -> Option<McpRegistryPackage> {
    Some(McpRegistryPackage {
        registry_type: package.registry_type?,
        identifier: NonEmptyText::new(package.identifier?)?,
        version: package.version,
        runtime_hint: package.runtime_hint,
        runtime_arguments: package.runtime_arguments.and_then(argument_records),
        package_arguments: package.package_arguments.and_then(argument_records),
    })
}

// Each argument with no value or default where it, or one of its variables, is secret; an
// argument a record cannot hold (one naming `__proto__`) is left out.
fn argument_records(arguments: Vec<Map<String, Value>>) -> Option<Vec<JsonRecord>> {
    let records = arguments.into_iter().filter_map(|mut argument| {
        drop_secret_value(&mut argument);
        if let Some(Value::Object(variables)) = argument.get_mut("variables") {
            for variable in variables.values_mut() {
                if let Value::Object(variable) = variable {
                    drop_secret_value(variable);
                }
            }
        }
        JsonRecord::new(
            argument
                .into_iter()
                .map(|(name, value)| (name, AnyValue(value)))
                .collect(),
        )
    });
    non_empty(records.collect())
}

// Removes `input`'s value and default when it is secret.
fn drop_secret_value(input: &mut Map<String, Value>) {
    if input.get("isSecret") == Some(&Value::Bool(true)) {
        input.remove("value");
        input.remove("default");
    }
}

// The contract's remote, or `None` when it names no transport, its address is neither a web
// address nor a template, or its template names a placeholder its variables do not declare.
fn registry_remote(remote: RemoteRecord) -> Option<McpRegistryRemote> {
    let variables: Vec<McpRegistryInput> = remote
        .variables
        .into_iter()
        .filter_map(|(name, variable)| {
            let record: InputRecord = serde_json::from_value(variable).ok()?;
            registry_input(Some(name), &record)
        })
        .collect();
    let address = remote.url?;
    let placeholders = placeholder_names(&address);
    let url = if placeholders.is_empty() {
        NonEmptyText::new(WebAddress::new(&address)?.as_str().to_owned())?
    } else {
        let is_declared = |placeholder: &&str| {
            variables
                .iter()
                .any(|variable| variable.name.as_str() == *placeholder)
        };
        if !is_template(&address) || !placeholders.iter().all(is_declared) {
            return None;
        }
        NonEmptyText::new(address)?
    };
    Some(McpRegistryRemote {
        transport: remote.transport?,
        url,
        variables: non_empty(variables),
        headers: non_empty(
            remote
                .headers
                .iter()
                .filter_map(|header| registry_input(header.name.clone(), header))
                .collect(),
        ),
    })
}

// The input named `name` with `record`'s description and flags, or `None` with no name.
fn registry_input(name: Option<String>, record: &InputRecord) -> Option<McpRegistryInput> {
    Some(McpRegistryInput {
        name: NonEmptyText::new(name?)?,
        description: record.description.clone(),
        is_required: record.is_required,
        is_secret: record.is_secret,
    })
}

// Whether `address` is written as the registry's address template: no whitespace, starting with
// `http://`, `https://` or a placeholder.
fn is_template(address: &str) -> bool {
    !address.chars().any(char::is_whitespace)
        && (address.starts_with("http://")
            || address.starts_with("https://")
            || placeholder_at_start(address).is_some())
}

// The name of each `{name}` placeholder in `template`, a name being a letter or `_` followed by
// letters, digits or `_`; braces around anything else are literal text.
fn placeholder_names(template: &str) -> Vec<&str> {
    let mut names = Vec::new();
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        rest = &rest[open..];
        match placeholder_at_start(rest) {
            Some(name) => {
                names.push(name);
                rest = &rest[name.len() + 2..];
            }
            None => rest = &rest[1..],
        }
    }
    names
}

// The placeholder's name when `text` starts with one.
fn placeholder_at_start(text: &str) -> Option<&str> {
    let inner = text.strip_prefix('{')?;
    let name = &inner[..inner.find('}')?];
    let mut characters = name.chars();
    let is_name = characters
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && characters.all(|character| character.is_ascii_alphanumeric() || character == '_');
    is_name.then_some(name)
}

// `items`, or `None` when there are none.
fn non_empty<T>(items: Vec<T>) -> Option<Vec<T>> {
    (!items.is_empty()).then_some(items)
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::Router;
    use axum::body::Body;
    use axum::http::header;
    use axum::response::IntoResponse as _;
    use axum::routing::get;
    use futures::stream;
    use rstest::rstest;
    use serde_json::json;
    use sidekicks_contracts::mcp::server::config::McpRequestText;
    use sidekicks_contracts::mcp::server::requests::{
        McpRegistrySearchRequest, McpRegistrySearchResponse,
    };

    use super::{McpRegistryClient, McpRegistrySearchError, SERVERS_PATH};

    /// A registry on a local port that answers every list with `page`, counting the requests;
    /// a streamed page goes as one chunk of a body that declares no length.
    async fn serve_page(page: String, is_streamed: bool) -> (McpRegistryClient, Arc<AtomicUsize>) {
        let requests = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&requests);
        let router = Router::new().route(
            SERVERS_PATH,
            get(move || async move {
                counted.fetch_add(1, Ordering::SeqCst);
                let body = if is_streamed {
                    Body::from_stream(stream::iter([Ok::<_, io::Error>(page)]))
                } else {
                    Body::from(page)
                };
                ([(header::CONTENT_TYPE, "application/json")], body).into_response()
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a local port");
        let address = listener.local_addr().expect("the port's address");
        tokio::spawn(async move { axum::serve(listener, router).await });
        (
            McpRegistryClient::new(&format!("http://{address}")),
            requests,
        )
    }

    fn search_request(query: &str) -> McpRegistrySearchRequest {
        McpRegistrySearchRequest {
            query: McpRequestText::new(query.to_owned()).expect("a search text"),
            cursor: None,
        }
    }

    #[rstest]
    #[case::two_letters("  ab  ")]
    #[case::two_code_points_in_four_bytes("éé ")]
    #[tokio::test]
    async fn a_query_under_three_code_points_sends_nothing(#[case] query: &str) {
        let (client, requests) = serve_page(json!({ "servers": [] }).to_string(), false).await;

        let page = client
            .search(&search_request(query))
            .await
            .expect("a short query answers");

        assert_eq!(
            page,
            McpRegistrySearchResponse {
                servers: Vec::new(),
                next_cursor: None,
            }
        );
        assert_eq!(requests.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn no_value_is_copied_and_a_templated_address_is_kept() {
        let page = json!({
            "servers": [{
                "server": {
                    "name": "io.example/weather",
                    "title": "Weather",
                    "description": "Forecasts.",
                    "version": "1.2.0",
                    "packages": [{
                        "registryType": "npm",
                        "identifier": "@example/weather",
                        "version": "1.2.0",
                        "runtimeHint": "npx",
                        "runtimeArguments": [
                            {
                                "type": "named",
                                "name": "--api-key",
                                "isSecret": true,
                                "value": "SECRET-ARG",
                                "default": "SECRET-DEFAULT"
                            },
                            { "type": "positional", "value": "--stdio" }
                        ],
                        "packageArguments": [{
                            "type": "named",
                            "name": "--key",
                            "value": "{key}",
                            "variables": {
                                "key": { "isSecret": true, "value": "SECRET-ARG-VAR" }
                            }
                        }],
                        "environmentVariables": [{
                            "name": "WEATHER_TOKEN",
                            "description": "The service's token.",
                            "isRequired": true,
                            "isSecret": true,
                            "value": "SECRET-ENV",
                            "default": "SECRET-ENV-DEFAULT"
                        }]
                    }],
                    "remotes": [
                        {
                            "type": "streamable-http",
                            "url": "https://{tenant}.example.com/mcp",
                            "variables": {
                                "tenant": {
                                    "description": "Your tenant.",
                                    "isRequired": true,
                                    "value": "SECRET-URL-VALUE",
                                    "default": "SECRET-URL-DEFAULT"
                                },
                                "token": { "isSecret": true, "value": "SECRET-URL-TOKEN" }
                            },
                            "headers": [{
                                "name": "Authorization",
                                "description": "A bearer token.",
                                "isRequired": true,
                                "isSecret": true,
                                "value": "SECRET-HEADER",
                                "default": "SECRET-HEADER-DEFAULT",
                                "variables": { "token": { "value": "SECRET-HEADER-VAR" } }
                            }]
                        },
                        { "type": "streamable-http", "url": "https://{region}.example.com/mcp" }
                    ]
                },
                "_meta": {}
            }],
            "metadata": { "nextCursor": "next", "count": 1 }
        });
        let (client, requests) = serve_page(page.to_string(), false).await;

        let answer = client
            .search(&search_request("weather"))
            .await
            .expect("the page answers");

        assert_eq!(requests.load(Ordering::SeqCst), 1);
        let written = serde_json::to_string(&answer).expect("the answer writes");
        assert!(
            !written.contains("SECRET-"),
            "a value was copied: {written}"
        );
        let written = serde_json::to_value(&answer).expect("the answer writes");
        assert_eq!(
            written,
            json!({
                "servers": [{
                    "name": "io.example/weather",
                    "title": "Weather",
                    "description": "Forecasts.",
                    "version": "1.2.0",
                    "packages": [{
                        "registryType": "npm",
                        "identifier": "@example/weather",
                        "version": "1.2.0",
                        "runtimeHint": "npx",
                        "runtimeArguments": [
                            { "isSecret": true, "name": "--api-key", "type": "named" },
                            { "type": "positional", "value": "--stdio" }
                        ],
                        "packageArguments": [{
                            "name": "--key",
                            "type": "named",
                            "value": "{key}",
                            "variables": { "key": { "isSecret": true } }
                        }]
                    }],
                    "remotes": [{
                        "type": "streamable-http",
                        "url": "https://{tenant}.example.com/mcp",
                        "variables": [
                            {
                                "name": "tenant",
                                "description": "Your tenant.",
                                "isRequired": true,
                                "isSecret": false
                            },
                            { "name": "token", "isRequired": false, "isSecret": true }
                        ],
                        "headers": [{
                            "name": "Authorization",
                            "description": "A bearer token.",
                            "isRequired": true,
                            "isSecret": true
                        }]
                    }],
                    "environmentVariables": [{
                        "name": "WEATHER_TOKEN",
                        "description": "The service's token.",
                        "isRequired": true,
                        "isSecret": true
                    }]
                }],
                "nextCursor": "next"
            })
        );
    }

    /// A reply past the bound is refused whether its length is declared or only read.
    #[rstest]
    #[case::declared(false)]
    #[case::streamed(true)]
    #[tokio::test]
    async fn a_reply_past_the_size_bound_is_refused(#[case] is_streamed: bool) {
        let page = json!({
            "servers": [{
                "server": {
                    "name": "io.example/large",
                    "description": "x".repeat(300 * 1024),
                    "version": "1.0.0"
                }
            }]
        });
        let (client, requests) = serve_page(page.to_string(), is_streamed).await;

        let answer = client.search(&search_request("large")).await;

        assert!(matches!(
            answer,
            Err(McpRegistrySearchError::Unavailable(_))
        ));
        assert_eq!(requests.load(Ordering::SeqCst), 1);
    }
}
