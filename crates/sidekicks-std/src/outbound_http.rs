//! The settings every outbound HTTP client of the daemon shares: an idle-connection cap per host
//! and a user agent naming the app with no version. No total timeout is set, since a long event
//! stream would be cut, and connection tracing is never on, since it writes raw bytes, paths and
//! headers included; each caller adds its own redirect policy and builds its own client.

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
