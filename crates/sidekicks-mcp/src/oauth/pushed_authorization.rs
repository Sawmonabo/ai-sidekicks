//! The pushed authorization request (RFC 9126): the authorization request's parameters go to the
//! authorization server in a direct post, and the browser opens the authorization page with only
//! the client id and the reference the server answered.
//!
//! - The post's body is the query of the authorization address already built (`client_id`,
//!   `state`, the PKCE challenge, `redirect_uri`, `resource`, the scopes), so none of them reaches
//!   the browser's history. For a `DPoP` sign-in the post carries a proof, which binds the code to
//!   the key (RFC 9449 §10.1).
//! - A server with no pushed-request endpoint gets the plain address, which for a `DPoP` sign-in
//!   names the key's thumbprint in `dpop_jkt` (RFC 9449 §10).
//! - `invalid_client` and `unauthorized_client` say the server does not admit this client, so they
//!   always come back as such. Another failure falls back to the plain address, unless the server
//!   requires pushed requests: then it fails the launch.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use reqwest::header::CONTENT_TYPE;
use reqwest::{Method, StatusCode, Url};
use serde_json::Value;

use super::dpop_proof::{
    AuthorizationServerResponse, DpopKey, DpopSendError, read_response, send_signed,
};

/// The metadata field (RFC 9126 §5) naming the pushed-request endpoint.
const PUSHED_AUTHORIZATION_REQUEST_ENDPOINT: &str = "pushed_authorization_request_endpoint";

/// The metadata field (RFC 9126 §5) saying the server takes authorization requests only pushed.
const REQUIRE_PUSHED_AUTHORIZATION_REQUESTS: &str = "require_pushed_authorization_requests";

/// How long the post may take, the bound rmcp gives each of its own OAuth calls.
const PUSHED_AUTHORIZATION_TIMEOUT: Duration = Duration::from_secs(30);

/// The authorization server's endpoints an authorization request needs, read from its metadata.
pub struct AuthorizationRequestEndpoints {
    authorization: Url,
    pushed_authorization_request: Option<Url>,
    are_pushed_requests_required: bool,
}

impl AuthorizationRequestEndpoints {
    /// The endpoints from the metadata's `authorization_endpoint` and its extra fields, where the
    /// pushed-request endpoint and its requirement live. Fails when an endpoint is not a URL, or
    /// when the server requires pushed requests and names no endpoint for them.
    pub fn from_metadata(
        authorization_endpoint: &str,
        additional_fields: &HashMap<String, Value>,
    ) -> Result<Self, PushedAuthorizationError> {
        let authorization = parse_endpoint("authorization_endpoint", Some(authorization_endpoint))?;
        let pushed_authorization_request = additional_fields
            .get(PUSHED_AUTHORIZATION_REQUEST_ENDPOINT)
            .map(|endpoint| {
                parse_endpoint(PUSHED_AUTHORIZATION_REQUEST_ENDPOINT, endpoint.as_str())
            })
            .transpose()?;
        let are_pushed_requests_required = additional_fields
            .get(REQUIRE_PUSHED_AUTHORIZATION_REQUESTS)
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if are_pushed_requests_required && pushed_authorization_request.is_none() {
            return Err(PushedAuthorizationError::RequiredWithoutEndpoint);
        }
        Ok(Self {
            authorization,
            pushed_authorization_request,
            are_pushed_requests_required,
        })
    }

    /// The pushed-request endpoint the post goes to, when the server names one: what a caller
    /// with an address filter judges before the post is sent.
    pub fn pushed_authorization_request(&self) -> Option<&Url> {
        self.pushed_authorization_request.as_ref()
    }
}

// The metadata's `field`, which must be a URL.
fn parse_endpoint(
    field: &'static str,
    endpoint: Option<&str>,
) -> Result<Url, PushedAuthorizationError> {
    let Some(endpoint) = endpoint else {
        return Err(PushedAuthorizationError::NotAnEndpoint { field, cause: None });
    };
    Url::parse(endpoint).map_err(|cause| PushedAuthorizationError::NotAnEndpoint {
        field,
        cause: Some(cause),
    })
}

/// The key and the authorization server's nonce slot a `DPoP` sign-in signs its post with; the
/// slot is the caller's, so the token request after it sends the nonce this post learned.
pub struct DpopSigning<'a> {
    /// The sign-in attempt's key.
    pub key: &'a DpopKey,
    /// The authorization server's last nonce.
    pub nonce: &'a Mutex<Option<String>>,
}

/// Why an authorization server refused a pushed request (RFC 9126 §2.3).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PushedAuthorizationRefusal {
    /// `invalid_client`: the server does not know or accept this client.
    #[error("invalid_client")]
    InvalidClient,
    /// `unauthorized_client`: the client may not make this request.
    #[error("unauthorized_client")]
    UnauthorizedClient,
    /// Any other error code, as the server sent it.
    #[error("{error}")]
    Other {
        /// The server's error code.
        error: String,
    },
}

/// Why no address for the browser came out of an authorization request.
#[derive(Debug, thiserror::Error)]
pub enum PushedAuthorizationError {
    /// An endpoint in the authorization server's metadata is not a URL.
    #[error("the authorization server's {field} is not a URL")]
    NotAnEndpoint {
        /// The metadata field naming the endpoint.
        field: &'static str,
        /// Why the text is no URL; none when the field is not text.
        #[source]
        cause: Option<url::ParseError>,
    },
    /// The server requires pushed requests and names no endpoint for them.
    #[error("the authorization server requires pushed requests and names no endpoint for them")]
    RequiredWithoutEndpoint,
    /// The authorization address carries no `client_id`.
    #[error("the authorization address carries no client id")]
    NoClientId,
    /// The server refused the pushed request.
    #[error("the authorization server refused the pushed request")]
    Refused(#[source] PushedAuthorizationRefusal),
    /// The post got no response.
    #[error("the pushed authorization request was not answered")]
    Send(#[from] DpopSendError),
    /// The server answered with neither a reference nor an error code.
    #[error("the authorization server answered the pushed request with {status} and no reference")]
    Unreadable {
        /// The answer's status.
        status: StatusCode,
    },
}

/// The address the browser opens for the authorization request `authorization_url` (built for
/// `endpoints.authorization`, its query holding the request's parameters and `client_id`). With a
/// pushed-request endpoint the query is posted there over `http`, signed when `dpop` is given, and
/// the address carries only `client_id` and the answered `request_uri`; without one it is
/// `authorization_url`, plus `dpop_jkt` for a `DPoP` sign-in. Fails on `invalid_client` or
/// `unauthorized_client`, and on any failed post where the server requires pushed requests.
pub async fn browser_authorization_url(
    http: &reqwest::Client,
    endpoints: &AuthorizationRequestEndpoints,
    authorization_url: &Url,
    dpop: Option<DpopSigning<'_>>,
) -> Result<Url, PushedAuthorizationError> {
    let Some(pushed_endpoint) = &endpoints.pushed_authorization_request else {
        return Ok(plain_url(authorization_url, dpop.as_ref()));
    };
    let client_id = authorization_url
        .query_pairs()
        .find_map(|(name, value)| (name == "client_id").then(|| value.into_owned()))
        .ok_or(PushedAuthorizationError::NoClientId)?;
    match push(http, pushed_endpoint, authorization_url, dpop.as_ref()).await {
        Ok(request_uri) => {
            let mut url = endpoints.authorization.clone();
            url.query_pairs_mut()
                .append_pair("client_id", &client_id)
                .append_pair("request_uri", &request_uri);
            Ok(url)
        }
        Err(
            error @ PushedAuthorizationError::Refused(
                PushedAuthorizationRefusal::InvalidClient
                | PushedAuthorizationRefusal::UnauthorizedClient,
            ),
        ) => Err(error),
        Err(error) if endpoints.are_pushed_requests_required => Err(error),
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "the pushed authorization request failed; the browser gets the plain address"
            );
            Ok(plain_url(authorization_url, dpop.as_ref()))
        }
    }
}

// `authorization_url` as built, with the key's thumbprint for a `DPoP` sign-in.
fn plain_url(authorization_url: &Url, dpop: Option<&DpopSigning<'_>>) -> Url {
    let mut url = authorization_url.clone();
    if let Some(dpop) = dpop {
        url.query_pairs_mut()
            .append_pair("dpop_jkt", dpop.key.thumbprint());
    }
    url
}

// Posts `authorization_url`'s query to `endpoint` and returns the `request_uri` answered.
async fn push(
    http: &reqwest::Client,
    endpoint: &Url,
    authorization_url: &Url,
    dpop: Option<&DpopSigning<'_>>,
) -> Result<String, PushedAuthorizationError> {
    let body = authorization_url.query().unwrap_or_default().to_owned();
    let finish = |request: reqwest::RequestBuilder| {
        request
            .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
            .timeout(PUSHED_AUTHORIZATION_TIMEOUT)
            .body(body.clone())
    };
    let response = match dpop {
        Some(dpop) => {
            send_signed(http, dpop.key, dpop.nonce, Method::POST, endpoint, finish).await?
        }
        None => {
            let request = http.request(Method::POST, endpoint.clone());
            let sent = finish(request).send().await.map_err(DpopSendError::from)?;
            read_response(sent).await?
        }
    };
    read_answer(&response)
}

// The `request_uri` of a success (RFC 9126 §2.2), or the refusal its error code names (§2.3).
fn read_answer(response: &AuthorizationServerResponse) -> Result<String, PushedAuthorizationError> {
    let unreadable = PushedAuthorizationError::Unreadable {
        status: response.status,
    };
    let Ok(body) = serde_json::from_slice::<Value>(&response.body) else {
        return Err(unreadable);
    };
    if response.status.is_success() {
        let request_uri = body.get("request_uri").and_then(Value::as_str);
        let has_expiry = body.get("expires_in").is_some_and(Value::is_u64);
        return match request_uri {
            Some(request_uri) if has_expiry => Ok(request_uri.to_owned()),
            _ => Err(unreadable),
        };
    }
    let refusal = match body.get("error").and_then(Value::as_str) {
        Some("invalid_client") => PushedAuthorizationRefusal::InvalidClient,
        Some("unauthorized_client") => PushedAuthorizationRefusal::UnauthorizedClient,
        Some(error) => PushedAuthorizationRefusal::Other {
            error: error.to_owned(),
        },
        None => return Err(unreadable),
    };
    Err(PushedAuthorizationError::Refused(refusal))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    use axum::Router;
    use axum::body::Body;
    use axum::http::StatusCode;
    use axum::response::Response;
    use axum::routing::post;
    use reqwest::Url;
    use serde_json::{Value, json};
    use sidekicks_std::mutex_lock::lock;

    use super::{
        AuthorizationRequestEndpoints, DpopSigning, PushedAuthorizationError,
        PushedAuthorizationRefusal, browser_authorization_url,
    };
    use crate::oauth::dpop_proof::DpopKey;

    // An authorization address as rmcp builds one for `endpoint`.
    fn authorization_url(endpoint: &str) -> Url {
        let mut url = Url::parse(endpoint).expect("a URL");
        url.query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("client_id", "client-4b1d")
            .append_pair("state", "state-9e2c")
            .append_pair("code_challenge", "challenge-51aa")
            .append_pair("code_challenge_method", "S256")
            .append_pair("redirect_uri", "http://127.0.0.1:7341/callback")
            .append_pair("resource", "https://tools.test/mcp");
        url
    }

    fn pairs(query: &str) -> HashMap<String, String> {
        Url::parse(&format!("http://form.test/?{query}"))
            .expect("a URL")
            .query_pairs()
            .into_owned()
            .collect()
    }

    // A fake authorization server whose `/par` answers `status` with `answer` and records each
    // body it is posted. Returns its base address and the record.
    async fn serve_par(status: StatusCode, answer: Value) -> (String, Arc<Mutex<Vec<String>>>) {
        let bodies: Arc<Mutex<Vec<String>>> = Arc::default();
        let recorded = Arc::clone(&bodies);
        let router = Router::new().route(
            "/par",
            post(move |body: String| async move {
                lock(&recorded).push(body);
                Response::builder()
                    .status(status)
                    .header("content-type", "application/json")
                    .body(Body::from(answer.to_string()))
                    .expect("a response")
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a local port");
        let address = listener.local_addr().expect("the port's address");
        tokio::spawn(async move { axum::serve(listener, router).await });
        (format!("http://{address}"), bodies)
    }

    fn endpoints(base: &str, fields: Value) -> AuthorizationRequestEndpoints {
        let fields: HashMap<String, Value> =
            serde_json::from_value(fields).expect("metadata fields");
        AuthorizationRequestEndpoints::from_metadata(&format!("{base}/authorize"), &fields)
            .expect("the endpoints")
    }

    // Mutation: in `browser_authorization_url`, skip the post and return the plain address; the
    // opened address then carries the challenge and `state`, and the server records no body.
    #[tokio::test]
    async fn a_pushed_request_leaves_the_browser_only_the_client_and_the_reference() {
        let (base, bodies) = serve_par(
            StatusCode::CREATED,
            json!({ "request_uri": "urn:ietf:params:oauth:request_uri:6esc", "expires_in": 60 }),
        )
        .await;
        let endpoints = endpoints(
            &base,
            json!({ "pushed_authorization_request_endpoint": format!("{base}/par") }),
        );

        let opened = browser_authorization_url(
            &reqwest::Client::new(),
            &endpoints,
            &authorization_url(&format!("{base}/authorize")),
            None,
        )
        .await
        .expect("an address");

        assert_eq!(opened.path(), "/authorize");
        assert_eq!(
            pairs(opened.query().unwrap_or_default()),
            HashMap::from([
                ("client_id".to_owned(), "client-4b1d".to_owned()),
                (
                    "request_uri".to_owned(),
                    "urn:ietf:params:oauth:request_uri:6esc".to_owned()
                ),
            ])
        );
        let posted = lock(&bodies).clone();
        let [body] = &posted[..] else {
            panic!("one pushed request");
        };
        let body = pairs(body);
        assert_eq!(body["client_id"], "client-4b1d");
        assert_eq!(body["code_challenge"], "challenge-51aa");
        assert_eq!(body["state"], "state-9e2c");
    }

    // Mutation: in `browser_authorization_url`, fall back to the plain address on every failed
    // post; the required server's refusal then comes back as an address.
    #[tokio::test]
    async fn a_required_pushed_request_that_is_refused_opens_nothing() {
        let (base, _bodies) = serve_par(
            StatusCode::BAD_REQUEST,
            json!({ "error": "invalid_request", "error_description": "bad scope" }),
        )
        .await;
        let endpoints = endpoints(
            &base,
            json!({
                "pushed_authorization_request_endpoint": format!("{base}/par"),
                "require_pushed_authorization_requests": true,
            }),
        );

        let outcome = browser_authorization_url(
            &reqwest::Client::new(),
            &endpoints,
            &authorization_url(&format!("{base}/authorize")),
            None,
        )
        .await;

        assert!(matches!(
            outcome,
            Err(PushedAuthorizationError::Refused(PushedAuthorizationRefusal::Other { error }))
                if error == "invalid_request"
        ));
    }

    // Mutation: in `plain_url`, leave out `dpop_jkt`; the opened address then names no key.
    #[tokio::test]
    async fn a_dpop_sign_in_with_no_pushed_endpoint_names_its_key_in_the_address() {
        let base = "https://auth.test";
        let endpoints = endpoints(base, json!({}));
        let key = DpopKey::generate();
        let nonce = Mutex::new(None);

        let opened = browser_authorization_url(
            &reqwest::Client::new(),
            &endpoints,
            &authorization_url(&format!("{base}/authorize")),
            Some(DpopSigning {
                key: &key,
                nonce: &nonce,
            }),
        )
        .await
        .expect("an address");

        let opened_pairs = pairs(opened.query().unwrap_or_default());
        assert_eq!(opened_pairs["dpop_jkt"], key.thumbprint());
        assert_eq!(opened_pairs["code_challenge"], "challenge-51aa");
        assert_eq!(opened_pairs["state"], "state-9e2c");
    }
}
