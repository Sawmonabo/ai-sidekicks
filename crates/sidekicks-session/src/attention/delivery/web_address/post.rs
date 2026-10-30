//! One `POST` of a message's frozen body to the web address, signed the Standard Webhooks way, and
//! how it ended. Nothing past the address's scheme and host leaves this module: user info in the
//! address moves into a sensitive `Basic` header before the request is built, every client error
//! drops its address before it is kept or logged, and the answer's body is never read.

use std::error::Error;
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use bytes::Bytes;
use jiff::Timestamp;
use percent_encoding::percent_decode_str;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderValue};
use reqwest::redirect::Policy;
use reqwest::{Client, StatusCode, Url};
use secrecy::SecretString;
use sidekicks_contracts::attention::AttentionDeliveryResult;
use sidekicks_contracts::web_address::WebAddress;
use sidekicks_contracts::wire::integer::BoundedInt;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::outbound_http::outbound_client_builder;

use crate::attention::delivery::web_address::signature::{UnreadableSigningSecret, sign_message};

/// How long an attempt waits for the address's answer, from the connection's start.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(15);

/// The idle connections kept to the address: the one a sequential sender reuses.
const IDLE_CONNECTIONS_PER_HOST: usize = 1;

/// The web address's HTTP client, built at its first post and kept until it is released; it
/// follows no redirect.
#[derive(Default)]
pub(crate) struct WebAddressPoster {
    client: Mutex<Option<Client>>,
}

/// One attempt to send a message: where, signed with what, its id, its frozen body and the
/// instant the attempt is made, whose Unix seconds are its `webhook-timestamp`.
pub(crate) struct WebAddressPost<'post> {
    /// The saved address.
    pub(crate) address: &'post WebAddress,
    /// The saved signing secret, `whsec_` and its key's base64.
    pub(crate) signing_secret: &'post SecretString,
    /// The message's `webhook-id`, the same at every attempt.
    pub(crate) message_id: &'post str,
    /// The message's body, the same bytes at every attempt.
    pub(crate) body: &'post Bytes,
    /// When the attempt is made.
    pub(crate) attempted_at: Timestamp,
}

/// How an attempt ended: the result and the address's HTTP status, `None` when it gave none or
/// one outside 100–599.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PostOutcome {
    /// How it ended.
    pub(crate) result: AttentionDeliveryResult,
    /// The address's status.
    pub(crate) http_status: Option<BoundedInt<100, 599>>,
}

/// Why no attempt was made.
#[derive(Debug, thiserror::Error)]
pub(crate) enum PostError {
    /// The HTTP client could not be built; the error carries no address.
    #[error("the web address's HTTP client could not be built")]
    Client(#[source] reqwest::Error),
    /// The saved signing secret does not read.
    #[error(transparent)]
    SigningSecret(#[from] UnreadableSigningSecret),
}

impl WebAddressPoster {
    /// Drops the client and, with it, the idle connection it keeps, once nothing is sent.
    pub(crate) fn release(&self) {
        lock(&self.client).take();
    }

    /// Whether a client is kept.
    #[cfg(test)]
    pub(crate) fn is_client_kept(&self) -> bool {
        lock(&self.client).is_some()
    }

    // The kept client, built when none is.
    fn client(&self) -> Result<Client, PostError> {
        let mut kept = lock(&self.client);
        if let Some(client) = kept.as_ref() {
            return Ok(client.clone());
        }
        let client = outbound_client_builder(IDLE_CONNECTIONS_PER_HOST)
            .redirect(Policy::none())
            .build()
            .map_err(|error| PostError::Client(error.without_url()))?;
        *kept = Some(client.clone());
        Ok(client)
    }

    /// Sends `post`'s body once and reports how it ended: a 2xx answer within 15 s `delivered`,
    /// any other answer, a redirect among them, `refused`, no answer in time `timedOut`, and no
    /// answer at all `unreachable`. Fails with [`PostError`] when no attempt could be made.
    pub(crate) async fn post(&self, post: WebAddressPost<'_>) -> Result<PostOutcome, PostError> {
        let client = self.client()?;
        let timestamp = post.attempted_at.as_second();
        let signature = sign_message(post.signing_secret, post.message_id, timestamp, post.body)?;
        let (url, authorization) = moved_user_info(post.address);
        let mut request = client
            .post(url)
            .timeout(ANSWER_TIMEOUT)
            .header(CONTENT_TYPE, "application/json")
            .header("webhook-id", post.message_id)
            .header("webhook-timestamp", timestamp.to_string())
            .header("webhook-signature", signature)
            .body(post.body.clone());
        if let Some(authorization) = authorization {
            request = request.header(AUTHORIZATION, authorization);
        }
        Ok(match request.send().await {
            // The answer's body is dropped unread: the receiver's text could echo the address.
            Ok(answer) => answered(answer.status()),
            Err(error) => unanswered(&error.without_url()),
        })
    }
}

fn answered(status: StatusCode) -> PostOutcome {
    let result = if status.is_success() {
        AttentionDeliveryResult::Delivered
    } else {
        AttentionDeliveryResult::Refused
    };
    tracing::info!(
        result = <&'static str>::from(result),
        status = status.as_u16(),
        "the web address answered"
    );
    PostOutcome {
        result,
        http_status: BoundedInt::new(i64::from(status.as_u16())),
    }
}

/// A failure with no answer: no answer in time is `timedOut`, any other, a refused connection, a
/// failed name lookup or TLS handshake or a dropped connection, `unreachable`.
fn unanswered(error: &reqwest::Error) -> PostOutcome {
    let result = if error.is_timeout() {
        AttentionDeliveryResult::TimedOut
    } else {
        AttentionDeliveryResult::Unreachable
    };
    tracing::info!(
        result = <&'static str>::from(result),
        error = error as &(dyn Error + 'static),
        "the web address did not answer"
    );
    PostOutcome {
        result,
        http_status: None,
    }
}

/// `address` with its user info taken out, and that user info as a sensitive `Basic` header: the
/// percent-decoded user and password as raw bytes, whatever their encoding, so none stays in the
/// address the client is handed.
fn moved_user_info(address: &WebAddress) -> (Url, Option<HeaderValue>) {
    let mut url = Url::parse(address.as_str()).expect("a web address parses");
    if url.username().is_empty() && url.password().is_none() {
        return (url, None);
    }
    let password = url.password().unwrap_or_default();
    let mut credentials = Vec::with_capacity(url.username().len() + 1 + password.len());
    credentials.extend(percent_decode_str(url.username()));
    credentials.push(b':');
    credentials.extend(percent_decode_str(password));
    url.set_username("")
        .expect("an http or https address takes a user name");
    url.set_password(None)
        .expect("an http or https address takes a password");
    // Not wiped: the header keeps a plain copy, as the address itself does at every attempt.
    let mut value = String::from("Basic ");
    STANDARD.encode_string(&credentials, &mut value);
    let mut header = HeaderValue::from_str(&value).expect("base64 is a header value");
    header.set_sensitive(true);
    (url, Some(header))
}

#[cfg(test)]
mod tests;
