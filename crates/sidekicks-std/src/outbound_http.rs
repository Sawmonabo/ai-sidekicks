//! The settings every outbound HTTP client of the daemon shares: an idle-connection cap per host
//! and a user agent naming the app with no version. No total timeout is set, since a long event
//! stream would be cut, and connection tracing is never on, since it writes raw bytes, paths and
//! headers included. A caller that follows no redirect keeps one client built on first use; a
//! body a caller reads whole is read here within the caller's cap. Also the download checked
//! against its digest before anything reads it.

pub mod download;

use std::sync::Mutex;

use reqwest::redirect::Policy;
use sidekicks_contracts::app_identity::APP_DISPLAY_NAME;

use crate::mutex_lock::lock;

/// A client builder with the shared settings, keeping at most `idle_connections_per_host` idle
/// connections to one host, each closed by reqwest's 90 s idle timeout.
pub fn outbound_client_builder(idle_connections_per_host: usize) -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .pool_max_idle_per_host(idle_connections_per_host)
        .user_agent(user_agent())
}

/// The app's name as one product token: a space would read as two.
fn user_agent() -> String {
    APP_DISPLAY_NAME.replace(' ', "-")
}

/// A client with the shared settings that follows no redirect, built on first use and kept, with
/// its idle connections, until released.
pub struct KeptOutboundClient {
    /// The idle connections the client keeps to one host.
    idle_connections_per_host: usize,
    /// The client, while one is kept.
    client: Mutex<Option<reqwest::Client>>,
}

impl KeptOutboundClient {
    /// No client yet; the first [`Self::client`] builds one keeping at most
    /// `idle_connections_per_host` idle connections to one host.
    pub const fn new(idle_connections_per_host: usize) -> Self {
        Self {
            idle_connections_per_host,
            client: Mutex::new(None),
        }
    }

    /// The kept client, built when none is. Fails as reqwest's build fails, the error carrying no
    /// address.
    pub fn client(&self) -> Result<reqwest::Client, reqwest::Error> {
        let mut kept = lock(&self.client);
        if let Some(client) = kept.as_ref() {
            return Ok(client.clone());
        }
        let client = outbound_client_builder(self.idle_connections_per_host)
            .redirect(Policy::none())
            .build()
            .map_err(reqwest::Error::without_url)?;
        *kept = Some(client.clone());
        Ok(client)
    }

    /// Drops the kept client and, once no request holds a clone, its idle connections.
    pub fn release(&self) {
        lock(&self.client).take();
    }

    /// Whether a client is kept.
    #[cfg(any(test, feature = "test-support"))]
    pub fn is_kept(&self) -> bool {
        lock(&self.client).is_some()
    }
}

/// Why a response body was not read within its cap.
#[derive(Debug, thiserror::Error)]
pub enum CappedBodyError {
    /// The body could not be read.
    #[error("the response body could not be read")]
    Read(#[source] reqwest::Error),
    /// The body, declared or read, is past the cap.
    #[error("the response body is past {max_bytes} bytes")]
    TooLarge {
        /// The cap, in bytes.
        max_bytes: usize,
    },
}

/// The whole of `response`'s body, read chunk by chunk within `max_bytes`. A declared length past
/// the cap is refused before any read, and a body that would pass it as soon as it would.
pub async fn read_capped_body(
    mut response: reqwest::Response,
    max_bytes: usize,
) -> Result<Vec<u8>, CappedBodyError> {
    let too_large = CappedBodyError::TooLarge { max_bytes };
    if response
        .content_length()
        .is_some_and(|declared| declared > max_bytes as u64)
    {
        return Err(too_large);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(CappedBodyError::Read)? {
        if chunk.len() > max_bytes - body.len() {
            return Err(too_large);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}
