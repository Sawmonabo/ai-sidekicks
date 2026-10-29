//! The HTTP every sign-in's OAuth calls go through, its address filter, and the client each
//! server's authorization manager sends with.
//!
//! - **The filter.** A host a call names may resolve to a public address; to a loopback address
//!   only for a server whose own address is loopback (`localhost` or a loopback literal); to a
//!   private address only for a server whose own address is a private literal; and never to a
//!   link-local (cloud metadata included), unspecified, broadcast, multicast or reserved address.
//!   An IPv4 address carried inside an IPv6 one is judged as that IPv4 address. A literal host,
//!   which reqwest connects to without resolving, and every redirect target are judged the same
//!   way, the server's own literal always allowed, and the cloud metadata names are refused
//!   outright. A server's own name is filtered too, so it cannot rebind to an internal address.
//!   The hosts of the proxies the environment names are not filtered, since a proxied call
//!   resolves only the proxy. Every call is judged, discovery, registration, token and pushed
//!   authorization alike.
//! - **Why the daemon keeps it.** rmcp filters this way only on the client it builds itself,
//!   whose resolver is private, and a manager given its own client checks host strings alone.
//!   The daemon gives each manager its own client so each server signs with its own key.
//! - **The pools.** A resolver sees only the name it resolves, never which server asked, so the
//!   filter lives in three shared pools, one per reach a server's address allows (public only,
//!   loopback, private); every sign-in shares them, and a connection kept in a pool was made under
//!   the same reach as any call that reuses it. Redirects are followed here, never by reqwest, so
//!   each hop is judged against the server's own policy.
//! - **The per-server client.** It holds the server's `DPoP` key slot, filled once discovery shows
//!   `DPoP`, and the authorization server's nonce slot; it signs token and pushed authorization
//!   requests through the signed send, applies each call's timeout, and keeps the outcome of the
//!   last registration request it sent.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::header::{
    AUTHORIZATION, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE, COOKIE, HeaderMap, LOCATION,
    PROXY_AUTHORIZATION, TRANSFER_ENCODING, WWW_AUTHENTICATE,
};
use reqwest::{Method, RequestBuilder, StatusCode, Url};
use rmcp::transport::auth::{
    OAuthHttpClient, OAuthHttpClientFuture, OAuthHttpRedirectPolicy, OAuthHttpRequest,
};
use secrecy::ExposeSecret as _;
use serde_json::Value;
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_std::mutex_lock::lock;
use url::Host;

use crate::oauth::dpop_proof::{
    AuthorizationServerResponse, DpopKey, DpopKeyError, DpopSendError, read_response, send_signed,
};
use crate::sign_in::canonical_server_address;
use crate::sign_in::credential_store::DpopKeyScalar;

/// The bound on one OAuth call when its caller sets none: rmcp's own for its OAuth calls.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// The idle connections each pool keeps per host: sign-ins are rare, so one is enough.
const IDLE_CONNECTIONS_PER_HOST: usize = 1;

/// The most redirects one call follows, rmcp's own bound.
const MAX_REDIRECTS: usize = 10;

/// The names cloud providers serve instance metadata under, refused whatever they resolve to.
const CLOUD_METADATA_HOSTS: [&str; 3] = [
    "metadata",
    "metadata.google.internal",
    "metadata.azure.internal",
];

/// The variables a proxy is named in, whose hosts the filter leaves alone.
const PROXY_VARIABLES: [&str; 6] = [
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
];

/// The three filtered pools every sign-in's OAuth calls share, one per reach a server's address
/// allows, each resolving names through the filter and following no redirect itself.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start builds the one set the sign-ins share"
    )
)]
pub(crate) struct OAuthHttpPools {
    public: reqwest::Client,
    loopback: reqwest::Client,
    private: reqwest::Client,
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start builds the pools and the sign-in's launch takes a client \
                  from them for each manager"
    )
)]
impl OAuthHttpPools {
    /// The pools over the system's resolver, leaving the hosts of the environment's proxies
    /// unfiltered. Fails when reqwest cannot build a pool.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the daemon's start builds the one set the sign-ins share"
        )
    )]
    pub(crate) fn new() -> Result<Self, reqwest::Error> {
        let proxy_hosts = PROXY_VARIABLES
            .iter()
            .filter_map(|variable| std::env::var(variable).ok())
            .filter_map(|proxy| proxy_host(&proxy))
            .collect();
        Self::with_lookup(Arc::new(SystemLookup), proxy_hosts)
    }

    // The pools resolving through `lookup`, with `unfiltered_hosts` left alone.
    fn with_lookup(
        lookup: Arc<dyn Resolve>,
        unfiltered_hosts: Arc<[String]>,
    ) -> Result<Self, reqwest::Error> {
        let build = |reach| {
            reqwest::Client::builder()
                .pool_max_idle_per_host(IDLE_CONNECTIONS_PER_HOST)
                .redirect(reqwest::redirect::Policy::none())
                .dns_resolver(Arc::new(FilteredResolver {
                    reach,
                    lookup: Arc::clone(&lookup),
                    unfiltered_hosts: Arc::clone(&unfiltered_hosts),
                }))
                .build()
        };
        Ok(Self {
            public: build(ServerReach::Public)?,
            loopback: build(ServerReach::Loopback)?,
            private: build(ServerReach::Private)?,
        })
    }

    /// A new client for one authorization manager of the server at `address`, judged by the
    /// server's canonical address, with an empty key slot and nonce slot.
    pub(crate) fn server_client(&self, address: &McpServerAddress) -> ServerOAuthHttpClient {
        let server = Url::parse(&canonical_server_address(address))
            .expect("a canonical server address parses as a web address");
        let policy = AddressPolicy::of_server(&server);
        let http = match policy.reach {
            ServerReach::Public => &self.public,
            ServerReach::Loopback => &self.loopback,
            ServerReach::Private => &self.private,
        };
        ServerOAuthHttpClient {
            http: http.clone(),
            policy,
            dpop_key: Mutex::new(None),
            nonce: Mutex::new(None),
            registration: Mutex::new(RegistrationOutcome::NotSent),
        }
    }
}

/// One authorization manager's OAuth client for one server: the pool its address allows, the
/// server's `DPoP` key slot and authorization-server nonce slot, and what its last registration
/// request got.
pub(crate) struct ServerOAuthHttpClient {
    http: reqwest::Client,
    policy: AddressPolicy,
    /// The key the server's token and pushed authorization requests are signed with: custody's
    /// own copy, empty for a bearer sign-in.
    dpop_key: Mutex<Option<Arc<DpopKeyScalar>>>,
    /// The last nonce the authorization server sent.
    nonce: Mutex<Option<String>>,
    registration: Mutex<RegistrationOutcome>,
}

/// What the last registration request a client sent got, read to tell a refusal from a failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RegistrationOutcome {
    /// No registration request was sent.
    NotSent,
    /// A registration request was sent and no response came: the network failed, the call ran
    /// out of time, or the filter refused its address.
    Unanswered,
    /// The registration endpoint answered.
    Answered {
        /// The response's status.
        status: StatusCode,
        /// The RFC 7591 `error` its body named, if any.
        error: Option<String>,
    },
}

/// One OAuth call a server's client sends.
pub(crate) struct OAuthCall {
    /// The request's method.
    pub(crate) method: Method,
    /// The request's target.
    pub(crate) url: Url,
    /// The request's own headers.
    pub(crate) headers: HeaderMap,
    /// The request's body.
    pub(crate) body: Vec<u8>,
    /// Whether redirects are followed, each target judged as the first; when not, a redirect
    /// comes back as it is.
    pub(crate) is_following_redirects: bool,
    /// The bound on each request the call sends.
    pub(crate) timeout: Duration,
}

/// Why an OAuth call got no response.
#[derive(Debug, thiserror::Error)]
pub(crate) enum OAuthCallError {
    /// The call's literal address, or a redirect's, is not one this server may reach.
    #[error("an OAuth call to `{0}` was refused: the address is not allowed for this server")]
    AddressRefused(Url),
    /// Every address the host resolved to is one this server may not reach.
    #[error("an OAuth call to `{0}` was refused: no address it resolves to is allowed")]
    HostRefused(String),
    /// The call was redirected more than the bound allows.
    #[error("an OAuth call was redirected more than {MAX_REDIRECTS} times")]
    TooManyRedirects,
    /// The request rmcp built names no web address.
    #[error("an OAuth request names no web address")]
    Target(#[source] url::ParseError),
    /// The key in the server's slot is not a P-256 key.
    #[error(transparent)]
    Key(#[from] DpopKeyError),
    /// The request failed on the network, its proof could not be made, or its body is past the
    /// bound.
    #[error(transparent)]
    Send(#[from] DpopSendError),
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the sign-in's launch fills the key slot and sends the pushed authorization \
                  request"
    )
)]
impl ServerOAuthHttpClient {
    /// Signs the server's token and pushed authorization requests with `dpop_key` from now on.
    pub(crate) fn set_dpop_key(&self, dpop_key: Arc<DpopKeyScalar>) {
        *lock(&self.dpop_key) = Some(dpop_key);
    }

    /// What the last registration request got, or that none was sent.
    pub(crate) fn registration_outcome(&self) -> RegistrationOutcome {
        lock(&self.registration).clone()
    }

    /// Sends `call`, its address and every redirect's judged first; a token or pushed
    /// authorization request carries a proof when the key slot is filled, and a JSON post is a
    /// registration request whose outcome is kept. Fails with [`OAuthCallError`].
    pub(crate) async fn call(
        &self,
        call: OAuthCall,
    ) -> Result<AuthorizationServerResponse, OAuthCallError> {
        let is_registration =
            call.method == Method::POST && has_content_type(&call.headers, "application/json");
        let result = self.follow(call).await;
        if is_registration {
            *lock(&self.registration) = match &result {
                Ok(response) => RegistrationOutcome::Answered {
                    status: response.status,
                    error: registration_error(&response.body),
                },
                Err(_) => RegistrationOutcome::Unanswered,
            };
        }
        result
    }

    // Sends `call`, following its redirects when it asks to, each target judged first.
    async fn follow(
        &self,
        mut call: OAuthCall,
    ) -> Result<AuthorizationServerResponse, OAuthCallError> {
        let mut redirects = 0;
        loop {
            if !self.policy.allows_url(&call.url) {
                return Err(OAuthCallError::AddressRefused(call.url));
            }
            let response = self.send_once(&call).await?;
            if !call.is_following_redirects {
                return Ok(response);
            }
            let Some(next) = response
                .headers
                .get(LOCATION)
                .and_then(|location| location.to_str().ok())
                .and_then(|location| call.url.join(location).ok())
            else {
                return Ok(response);
            };
            match response.status {
                StatusCode::MOVED_PERMANENTLY | StatusCode::FOUND | StatusCode::SEE_OTHER => {
                    call.body.clear();
                    for name in [
                        CONTENT_TYPE,
                        CONTENT_LENGTH,
                        CONTENT_ENCODING,
                        TRANSFER_ENCODING,
                    ] {
                        call.headers.remove(name);
                    }
                    if call.method != Method::HEAD {
                        call.method = Method::GET;
                    }
                }
                StatusCode::TEMPORARY_REDIRECT | StatusCode::PERMANENT_REDIRECT => {}
                _ => return Ok(response),
            }
            if redirects == MAX_REDIRECTS {
                return Err(OAuthCallError::TooManyRedirects);
            }
            redirects += 1;
            if next.origin() != call.url.origin() {
                for name in [AUTHORIZATION, COOKIE, PROXY_AUTHORIZATION, WWW_AUTHENTICATE] {
                    call.headers.remove(name);
                }
            }
            call.url = next;
        }
    }

    // Sends `call` once, signed when it is a token or pushed authorization request and the key
    // slot is filled.
    async fn send_once(
        &self,
        call: &OAuthCall,
    ) -> Result<AuthorizationServerResponse, OAuthCallError> {
        let finish = |request: RequestBuilder| {
            request
                .headers(call.headers.clone())
                .body(call.body.clone())
                .timeout(call.timeout)
        };
        let dpop_key = if is_bound_to_key(call) {
            lock(&self.dpop_key).clone()
        } else {
            None
        };
        let Some(dpop_key) = dpop_key else {
            let request = finish(self.http.request(call.method.clone(), call.url.clone()));
            let response = request.send().await.map_err(DpopSendError::Http)?;
            return Ok(read_response(response).await?);
        };
        let key = DpopKey::from_scalar(dpop_key.expose_secret())?;
        Ok(send_signed(
            &self.http,
            &key,
            &self.nonce,
            call.method.clone(),
            &call.url,
            finish,
        )
        .await?)
    }
}

impl OAuthHttpClient for ServerOAuthHttpClient {
    fn execute(&self, request: OAuthHttpRequest) -> OAuthHttpClientFuture<'_> {
        Box::pin(async move {
            let OAuthHttpRequest {
                request,
                redirect_policy,
                timeout,
                ..
            } = request;
            let (parts, body) = request.into_parts();
            let call = OAuthCall {
                method: parts.method,
                url: Url::parse(&parts.uri.to_string()).map_err(OAuthCallError::Target)?,
                headers: parts.headers,
                body,
                is_following_redirects: redirect_policy == OAuthHttpRedirectPolicy::Follow,
                timeout: timeout.unwrap_or(CALL_TIMEOUT),
            };
            let answer = self.call(call).await?;
            let mut response = http::Response::new(answer.body.to_vec());
            *response.status_mut() = answer.status;
            *response.headers_mut() = answer.headers;
            Ok(response)
        })
    }
}

// Whether `call` is a token request (it names a `grant_type`) or a pushed authorization request
// (it names a `response_type`), the two a `DPoP` sign-in signs.
fn is_bound_to_key(call: &OAuthCall) -> bool {
    call.method == Method::POST
        && has_content_type(&call.headers, "application/x-www-form-urlencoded")
        && url::form_urlencoded::parse(&call.body)
            .any(|(name, _)| name == "grant_type" || name == "response_type")
}

// Whether `headers` declare a body of `media_type`, parameters aside.
fn has_content_type(headers: &HeaderMap, media_type: &str) -> bool {
    headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case(media_type))
}

// The RFC 7591 `error` a registration response's JSON body names.
fn registration_error(body: &[u8]) -> Option<String> {
    serde_json::from_slice::<Value>(body)
        .ok()?
        .get("error")?
        .as_str()
        .map(str::to_owned)
}

// The host a proxy variable's value names, as the filter compares names.
fn proxy_host(proxy: &str) -> Option<String> {
    let proxy = if proxy.contains("://") {
        proxy.to_owned()
    } else {
        format!("http://{proxy}")
    };
    Url::parse(&proxy).ok()?.host_str().map(normalized_host)
}

// `host` as names are compared: lowercase, without a trailing dot.
fn normalized_host(host: &str) -> String {
    host.trim_end_matches('.').to_ascii_lowercase()
}

// Whether `host` is a name loopback is reached under.
fn is_loopback_name(host: &str) -> bool {
    host == "localhost" || host.ends_with(".localhost")
}

/// What a server's own address lets its OAuth calls reach besides public addresses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ServerReach {
    /// Public addresses only.
    Public,
    /// Loopback addresses too: the server is `localhost` or a loopback literal.
    Loopback,
    /// Private addresses too: the server is a private literal.
    Private,
}

impl ServerReach {
    fn allows(self, class: AddressClass) -> bool {
        match class {
            AddressClass::Public => true,
            AddressClass::Loopback => self == Self::Loopback,
            AddressClass::Private => self == Self::Private,
            AddressClass::Blocked => false,
        }
    }
}

/// The filter's judgment for one server: its reach and its own literal address, if it has one.
#[derive(Debug, Clone, Copy)]
struct AddressPolicy {
    reach: ServerReach,
    server_ip: Option<IpAddr>,
}

impl AddressPolicy {
    fn of_server(server: &Url) -> Self {
        let server_ip = literal_ip(server);
        let reach = match server_ip.map(AddressClass::of) {
            Some(AddressClass::Loopback) => ServerReach::Loopback,
            Some(AddressClass::Private) => ServerReach::Private,
            Some(AddressClass::Public | AddressClass::Blocked) => ServerReach::Public,
            None if server
                .host_str()
                .is_some_and(|host| is_loopback_name(&normalized_host(host))) =>
            {
                ServerReach::Loopback
            }
            None => ServerReach::Public,
        };
        Self { reach, server_ip }
    }

    // Whether a call may go to `url`: a literal host by its class or as the server's own literal;
    // a name unless it is a cloud metadata name, its addresses judged as it resolves.
    fn allows_url(&self, url: &Url) -> bool {
        match url.host() {
            Some(Host::Domain(domain)) => !is_cloud_metadata_name(&normalized_host(domain)),
            Some(_) => literal_ip(url).is_some_and(|ip| {
                self.server_ip == Some(ip) || self.reach.allows(AddressClass::of(ip))
            }),
            None => false,
        }
    }
}

// Whether `host` is a name cloud providers serve instance metadata under.
fn is_cloud_metadata_name(host: &str) -> bool {
    CLOUD_METADATA_HOSTS.contains(&host)
}

// The address `url` names as a literal host.
fn literal_ip(url: &Url) -> Option<IpAddr> {
    match url.host()? {
        Host::Ipv4(v4) => Some(IpAddr::V4(v4)),
        Host::Ipv6(v6) => Some(IpAddr::V6(v6)),
        Host::Domain(_) => None,
    }
}

/// The class of an address the filter judges.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AddressClass {
    Public,
    Loopback,
    Private,
    /// Link-local, unspecified, broadcast, multicast or reserved: never reached.
    Blocked,
}

impl AddressClass {
    fn of(address: IpAddr) -> Self {
        match address {
            IpAddr::V4(v4) => Self::of_ipv4(v4),
            IpAddr::V6(v6) => embedded_ipv4(v6).map_or_else(|| Self::of_ipv6(v6), Self::of_ipv4),
        }
    }

    fn of_ipv4(address: Ipv4Addr) -> Self {
        let [first, second, ..] = address.octets();
        if address.is_loopback() {
            Self::Loopback
        } else if address.is_private() || (first == 100 && (64..=127).contains(&second)) {
            Self::Private
        } else if address.is_link_local()
            || address.is_multicast()
            || first == 0
            || first >= 240
            || (first == 198 && matches!(second, 18 | 19))
        {
            Self::Blocked
        } else {
            Self::Public
        }
    }

    fn of_ipv6(address: Ipv6Addr) -> Self {
        let segments = address.segments();
        if address.is_loopback() {
            Self::Loopback
        } else if (segments[0] & 0xfe00) == 0xfc00 {
            Self::Private
        } else if address.is_unspecified()
            || address.is_multicast()
            || (segments[0] & 0xffc0) == 0xfe80
            || segments[..2] == [0x2001, 0]
            || segments[..3] == [0x64, 0xff9b, 1]
        {
            Self::Blocked
        } else {
            Self::Public
        }
    }
}

// The IPv4 address an IPv6 address carries: mapped, compatible, NAT64 (`64:ff9b::/96`) or 6to4
// (`2002::/16`). Teredo and local NAT64 are blocked by their own prefixes instead.
fn embedded_ipv4(address: Ipv6Addr) -> Option<Ipv4Addr> {
    let [a, b, c, d, e, f, g, h] = address.segments();
    let low = Ipv4Addr::from((u32::from(g) << 16) | u32::from(h));
    match [a, b, c, d, e, f] {
        [0, 0, 0, 0, 0, 0xffff] | [0x64, 0xff9b, 0, 0, 0, 0] => Some(low),
        [0, 0, 0, 0, 0, 0] if !address.is_loopback() && !address.is_unspecified() => Some(low),
        [0x2002, ..] => Some(Ipv4Addr::from((u32::from(b) << 16) | u32::from(c))),
        _ => None,
    }
}

// Resolves names, keeping only the addresses a pool's reach allows; a name with none left is
// refused, and the proxies' hosts are left alone.
struct FilteredResolver {
    reach: ServerReach,
    lookup: Arc<dyn Resolve>,
    unfiltered_hosts: Arc<[String]>,
}

impl Resolve for FilteredResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let reach = self.reach;
        let lookup = Arc::clone(&self.lookup);
        let unfiltered_hosts = Arc::clone(&self.unfiltered_hosts);
        Box::pin(async move {
            let host = normalized_host(name.as_str());
            if unfiltered_hosts.contains(&host) {
                return lookup.resolve(name).await;
            }
            if is_cloud_metadata_name(&host) {
                return Err(Box::new(OAuthCallError::HostRefused(host)) as _);
            }
            let allowed: Vec<SocketAddr> = lookup
                .resolve(name)
                .await?
                .filter(|address| reach.allows(AddressClass::of(address.ip())))
                .collect();
            if allowed.is_empty() {
                tracing::warn!(host, "no address of an OAuth call's host is allowed");
                return Err(Box::new(OAuthCallError::HostRefused(host)) as _);
            }
            Ok(Box::new(allowed.into_iter()) as Addrs)
        })
    }
}

// Resolves names with the operating system's resolver.
struct SystemLookup;

impl Resolve for SystemLookup {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let addresses = tokio::net::lookup_host((host, 0)).await?;
            Ok(Box::new(addresses) as Addrs)
        })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::error::Error;
    use std::net::{IpAddr, SocketAddr};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use axum::Router;
    use axum::http::{HeaderMap as AxumHeaderMap, StatusCode as AxumStatusCode, Uri};
    use axum::routing::post;
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use jwt_simple::prelude::ES256PublicKey;
    use reqwest::dns::{Addrs, Name, Resolve, Resolving};
    use reqwest::header::{CONTENT_TYPE, HeaderMap, HeaderValue};
    use reqwest::{Method, Url};
    use secrecy::SecretBox;
    use serde_json::Value;
    use sidekicks_contracts::mcp::server::config::McpServerAddress;
    use sidekicks_std::mutex_lock::lock;

    use super::{AddressPolicy, OAuthCall, OAuthCallError, OAuthHttpPools};
    use crate::oauth::dpop_proof::DpopKey;

    // Answers each name it knows with its addresses, and any other name with none.
    struct StaticLookup(HashMap<&'static str, Vec<IpAddr>>);

    impl Resolve for StaticLookup {
        fn resolve(&self, name: Name) -> Resolving {
            let addresses: Vec<SocketAddr> = self
                .0
                .get(name.as_str())
                .into_iter()
                .flatten()
                .map(|ip| SocketAddr::new(*ip, 0))
                .collect();
            Box::pin(async move { Ok(Box::new(addresses.into_iter()) as Addrs) })
        }
    }

    fn pools(names: &[(&'static str, &str)]) -> OAuthHttpPools {
        let lookup = names
            .iter()
            .map(|(name, ip)| (*name, vec![ip.parse().expect("an address")]))
            .collect();
        OAuthHttpPools::with_lookup(Arc::new(StaticLookup(lookup)), Arc::new([]))
            .expect("the pools build")
    }

    fn server(text: &str) -> McpServerAddress {
        McpServerAddress::new(text).expect("a server address")
    }

    fn get(url: &str) -> OAuthCall {
        OAuthCall {
            method: Method::GET,
            url: Url::parse(url).expect("a URL"),
            headers: HeaderMap::new(),
            body: Vec::new(),
            is_following_redirects: false,
            timeout: Duration::from_secs(5),
        }
    }

    // Whether `error`'s source chain holds the filter's refusal.
    fn is_refused(error: &OAuthCallError) -> bool {
        let mut source: Option<&(dyn Error + 'static)> = Some(error);
        while let Some(error) = source {
            if matches!(
                error.downcast_ref::<OAuthCallError>(),
                Some(OAuthCallError::AddressRefused(_) | OAuthCallError::HostRefused(_))
            ) {
                return true;
            }
            source = error.source();
        }
        false
    }

    // A loopback service recording the path of every request that reaches it.
    async fn recording_service() -> (SocketAddr, Arc<Mutex<Vec<String>>>) {
        let hits: Arc<Mutex<Vec<String>>> = Arc::default();
        let recorded = Arc::clone(&hits);
        let router = Router::new().fallback(move |uri: Uri| async move {
            lock(&recorded).push(uri.path().to_owned());
            AxumStatusCode::NOT_FOUND
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a local port");
        let address = listener.local_addr().expect("the port's address");
        tokio::spawn(async move { axum::serve(listener, router).await });
        (address, hits)
    }

    // Mutation: drop the filtered resolver from the pools, so names resolve through the system;
    // or judge an IPv6 address without the IPv4 address it carries. The first fails the loopback
    // server's reach of its named authorization server and the refusals' kind; the second lets
    // the mapped forms through.
    #[tokio::test]
    async fn a_server_reaches_only_the_addresses_its_own_address_allows() {
        let (service, hits) = recording_service().await;
        let port = service.port();
        let pools = pools(&[
            ("internal.test", "127.0.0.1"),
            ("private.test", "10.0.0.9"),
            ("auth.loopback.test", "127.0.0.1"),
        ]);
        let public = pools.server_client(&server("https://mcp.example.test/mcp"));
        for url in [
            format!("http://internal.test:{port}/.well-known/oauth-authorization-server"),
            format!("http://private.test:{port}/token"),
            format!("http://127.0.0.1:{port}/token"),
            format!("http://[::ffff:127.0.0.1]:{port}/token"),
        ] {
            let error = public
                .call(get(&url))
                .await
                .err()
                .unwrap_or_else(|| panic!("{url} was reached"));
            assert!(is_refused(&error), "{url} failed otherwise: {error}");
        }
        assert!(lock(&hits).is_empty(), "the internal service was reached");

        let loopback = pools.server_client(&server(&format!("http://127.0.0.1:{port}/mcp")));
        for policy in [&public.policy, &loopback.policy] {
            for url in [
                "http://169.254.169.254/latest",
                "http://[::ffff:169.254.169.254]/",
            ] {
                assert!(
                    !policy.allows_url(&Url::parse(url).expect("a URL")),
                    "{url}"
                );
            }
        }
        assert!(
            !AddressPolicy::of_server(&Url::parse("https://mcp.example.test/").expect("a URL"))
                .allows_url(&Url::parse("http://metadata.google.internal/").expect("a URL"))
        );

        let response = loopback
            .call(get(&format!(
                "http://auth.loopback.test:{port}/.well-known/oauth-authorization-server"
            )))
            .await
            .expect("a loopback server reaches its loopback authorization server");
        assert_eq!(response.status, reqwest::StatusCode::NOT_FOUND);
        assert_eq!(
            *lock(&hits),
            ["/.well-known/oauth-authorization-server".to_owned()]
        );
    }

    // The thumbprint of the key that signed the proof in `headers`.
    fn proof_thumbprint(headers: &AxumHeaderMap) -> String {
        let proof = headers
            .get("dpop")
            .and_then(|proof| proof.to_str().ok())
            .expect("a token request carries a proof");
        let header = proof.split('.').next().expect("a proof has a header");
        let header: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(header).expect("a base64url header"))
                .expect("a JSON header");
        ES256PublicKey::from_jwk(&header["jwk"].to_string())
            .expect("a public P-256 JWK")
            .jwk_thumbprint()
    }

    // Mutation: keep one key slot for every server's client; the second server's token request
    // then carries the first server's key.
    #[tokio::test]
    async fn two_servers_behind_one_token_endpoint_each_sign_with_their_own_key() {
        let thumbprints: Arc<Mutex<Vec<String>>> = Arc::default();
        let recorded = Arc::clone(&thumbprints);
        let router = Router::new().route(
            "/token",
            post(move |headers: AxumHeaderMap| async move {
                lock(&recorded).push(proof_thumbprint(&headers));
                AxumStatusCode::OK
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a local port");
        let address = listener.local_addr().expect("the port's address");
        tokio::spawn(async move { axum::serve(listener, router).await });
        let pools = pools(&[]);
        let mut keys = Vec::new();
        for path in ["first", "second"] {
            let client = pools.server_client(&server(&format!("http://127.0.0.1:1/{path}")));
            let key = DpopKey::generate();
            client.set_dpop_key(Arc::new(SecretBox::new(Box::new(key.to_scalar()))));
            let mut headers = HeaderMap::new();
            headers.insert(
                CONTENT_TYPE,
                HeaderValue::from_static("application/x-www-form-urlencoded"),
            );
            let response = client
                .call(OAuthCall {
                    method: Method::POST,
                    url: Url::parse(&format!("http://{address}/token")).expect("a URL"),
                    headers,
                    body: b"grant_type=authorization_code&code=c1".to_vec(),
                    is_following_redirects: false,
                    timeout: Duration::from_secs(5),
                })
                .await
                .expect("the token endpoint answers");
            assert_eq!(response.status, reqwest::StatusCode::OK);
            keys.push(key.thumbprint().to_owned());
        }

        assert_ne!(keys[0], keys[1]);
        assert_eq!(*lock(&thumbprints), keys);
    }
}
