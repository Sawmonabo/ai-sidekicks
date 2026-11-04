//! The settings every outbound HTTP client of the daemon shares: an idle-connection cap per host
//! and a user agent naming the app with no version. No total timeout is set, since a long event
//! stream would be cut, and connection tracing is never on, since it writes raw bytes, paths and
//! headers included; each caller adds its own redirect policy and builds its own client. A body
//! a caller reads whole is read here within the caller's cap.

use sidekicks_contracts::app_identity::APP_DISPLAY_NAME;

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
