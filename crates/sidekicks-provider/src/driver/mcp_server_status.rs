//! An MCP server's status as a driver reports it for its session leg, the bound every driver's
//! status reader puts a reported pair through, and the leg-stamped update the daemon reads, keyed
//! per binding and server.

use std::sync::Arc;

use serde_json::Value;
use sidekicks_contracts::mcp::server::{McpServerName, McpServerStatus};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;

/// What a driver reports for one MCP server: its name, bounded where the driver read it from
/// provider output, and its status. It carries no leg identity: the producer it goes to is bound
/// to the leg at spawn, so a driver cannot report for another leg.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpServerStatusEmission {
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
    pub(crate) binding_id: RuntimeBindingId,
    /// The server's name.
    pub(crate) server_name: McpServerName,
    /// Its status.
    pub(crate) status: McpServerStatus,
}

/// The status sink the daemon hands a driver, bound to the leg at spawn. It returns nothing and
/// is never awaited, so a slow reader cannot hold back the provider's status stream.
pub(crate) type McpServerStatusProducer = Arc<dyn Fn(McpServerStatusEmission) + Send + Sync>;

/// A raw row, line or notification a driver's status reader could not turn into a bounded
/// emission. It is returned, never dropped, so a malformed row shows as a visible gap.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct McpServerStatusIngestRejection {
    /// Why the pair was refused.
    pub(crate) reason: String,
}

/// What a driver's status reader made of one raw payload: the bounded emissions and the pairs it
/// refused.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct McpServerStatusIngestResult {
    /// The pairs that passed the bound.
    pub(crate) emissions: Vec<McpServerStatusEmission>,
    /// The pairs refused, each with its reason.
    pub(crate) rejections: Vec<McpServerStatusIngestRejection>,
}

/// Bounds one reported (server name, status) pair. The name is untrusted provider output: one that
/// is not text, is blank, holds a NUL or passes its length bound comes back as a rejection instead
/// of reaching the leg's producer.
pub(crate) fn bound_mcp_server_status_emission(
    server_name: &Value,
    status: McpServerStatus,
) -> Result<McpServerStatusEmission, McpServerStatusIngestRejection> {
    let Some(server_name) = server_name.as_str() else {
        return Err(McpServerStatusIngestRejection {
            reason: "MCP server-status emission rejected at the wire bound: the server name is \
                     not text"
                .to_owned(),
        });
    };
    FreeFormText::new(server_name.to_owned())
        .map(|server_name| McpServerStatusEmission {
            server_name,
            status,
        })
        .map_err(|text_failure| McpServerStatusIngestRejection {
            reason: format!(
                "MCP server-status emission rejected at the wire bound: the server name: \
                 {text_failure}"
            ),
        })
}
