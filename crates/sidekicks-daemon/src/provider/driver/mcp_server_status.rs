//! An MCP server's status as a driver reports it for its session leg, and the leg-stamped update
//! the daemon reads, keyed per binding and server.

use std::sync::Arc;

use sidekicks_contracts::mcp::server::{McpServerName, McpServerStatus};
use sidekicks_contracts::session::id::SessionId;

/// What a driver reports for one MCP server: its name, bounded where the driver read it from
/// provider output, and its status. It carries no leg identity: the producer it goes to is bound
/// to the leg at spawn, so a driver cannot report for another leg.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct McpServerStatusEmission {
    /// The server's name.
    pub(crate) server_name: McpServerName,
    /// Its status.
    pub(crate) status: McpServerStatus,
}

/// One server's status as the daemon reads it, stamped with the leg the producer was bound to.
/// A run has many bindings, so statuses key per binding and server: a relaunched leg's census
/// replaces its predecessor's without touching a live leg's rows.
#[expect(
    dead_code,
    reason = "the MCP server settings' live status reads each leg's server states through it"
)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct McpServerStatusUpdate {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The binding the producer was bound to.
    pub(crate) binding_id: String,
    /// The server's name.
    pub(crate) server_name: McpServerName,
    /// Its status.
    pub(crate) status: McpServerStatus,
}

/// The status sink the daemon hands a driver, bound to the leg at spawn. It returns nothing and
/// is never awaited, so a slow reader cannot hold back the provider's status stream.
pub(crate) type McpServerStatusProducer = Arc<dyn Fn(McpServerStatusEmission) + Send + Sync>;
