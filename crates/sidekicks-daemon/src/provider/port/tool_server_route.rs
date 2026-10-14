//! Where a provider reaches the daemon's tool servers for a session: the route the daemon's
//! tool-server front registers once it runs.

use sidekicks_contracts::session::id::SessionId;

/// The address of each of a session's tool servers, registered through a `PortRegistration`.
/// Until it is registered, a session starts with no daemon tool server entry.
pub(crate) trait ToolServerRoute: Send + Sync {
    /// The address a provider reaches `server_name` at for `session_id`.
    fn url_for(&self, session_id: &SessionId, server_name: &str) -> String;
}
