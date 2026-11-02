//! How a confidential client authenticates with its secret at an authorization server's endpoint
//! (RFC 6749 §2.3.1): `client_secret_basic`, the default where the metadata names no method
//! (RFC 8414 §2), or `client_secret_post`. The secret goes only into the request; the header that
//! carries it is marked sensitive, and nothing here prints it.

use std::collections::HashMap;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};
use secrecy::zeroize::Zeroizing;
use secrecy::{ExposeSecret as _, SecretString};
use serde_json::Value;

/// The metadata field (RFC 8414 §2) listing the methods the token endpoint takes, which the
/// pushed-request endpoint takes too (RFC 9126 §2).
pub const TOKEN_ENDPOINT_AUTH_METHODS: &str = "token_endpoint_auth_methods_supported";

/// The metadata field (RFC 8414 §2) listing the methods the revocation endpoint takes.
pub const REVOCATION_ENDPOINT_AUTH_METHODS: &str = "revocation_endpoint_auth_methods_supported";

/// How an endpoint takes a client's secret.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientSecretMethod {
    /// `client_secret_basic`: an HTTP Basic `Authorization` of the form-encoded id and secret.
    Basic,
    /// `client_secret_post`: `client_secret` in the request's form, beside its `client_id`.
    Post,
}

impl ClientSecretMethod {
    /// The method the metadata's `field`, a list of method names in `additional_fields`, gives:
    /// `client_secret_post` only where the list names it and not `client_secret_basic`, as rmcp
    /// picks the token endpoint's; `client_secret_basic` otherwise.
    pub fn from_metadata(additional_fields: &HashMap<String, Value>, field: &str) -> Self {
        let names = |name: &str| {
            additional_fields
                .get(field)
                .and_then(Value::as_array)
                .is_some_and(|methods| methods.iter().any(|method| method.as_str() == Some(name)))
        };
        if names("client_secret_post") && !names("client_secret_basic") {
            Self::Post
        } else {
            Self::Basic
        }
    }
}

/// A confidential client's id and secret, and the method one endpoint takes them by.
pub struct ClientSecretAuthentication<'a> {
    /// The client's id.
    pub client_id: &'a str,
    /// The secret the server issued the client.
    pub client_secret: &'a SecretString,
    /// How the endpoint takes the secret.
    pub method: ClientSecretMethod,
}

impl ClientSecretAuthentication<'_> {
    /// Authenticates a form post whose body is `form`: `client_secret` is appended to it, or a
    /// sensitive Basic `Authorization` goes into `headers`.
    pub fn authenticate(&self, form: &mut String, headers: &mut HeaderMap) {
        let secret = self.client_secret.expose_secret();
        match self.method {
            ClientSecretMethod::Post => {
                url::form_urlencoded::Serializer::new(form).append_pair("client_secret", secret);
            }
            ClientSecretMethod::Basic => {
                let encoded = |text: &str| -> Zeroizing<String> {
                    Zeroizing::new(url::form_urlencoded::byte_serialize(text.as_bytes()).collect())
                };
                let pair: Zeroizing<String> =
                    Zeroizing::new(format!("{}:{}", *encoded(self.client_id), *encoded(secret)));
                let value = Zeroizing::new(format!("Basic {}", STANDARD.encode(pair.as_bytes())));
                let mut value = HeaderValue::from_str(&value)
                    .expect("base64 text after the scheme is a header value");
                value.set_sensitive(true);
                headers.insert(AUTHORIZATION, value);
            }
        }
    }
}
