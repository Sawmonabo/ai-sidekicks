//! An MCP server's reading as a driver reports it for its session leg, the bound every driver's
//! status reader puts a reported row through, and the leg-stamped update the daemon reads, keyed
//! per binding and server.

use std::sync::Arc;

use serde_json::Value;
use sidekicks_contracts::error::ERROR_MESSAGE_MAX_LEN;
use sidekicks_contracts::mcp::server::{McpServerName, McpServerStatus};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::{FreeFormText, is_ecmascript_whitespace};
use sidekicks_std::text_cut::cut_to_code_points;

/// What a provider reported about one MCP server for a session: a status it observed, or that it
/// switched the server off for this conversation or project.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum McpServerReading {
    /// The server's connection status.
    Observed(McpServerStatus),
    /// The provider switched the server off for this conversation or project; it is not a status.
    SwitchedOff,
}

/// What a driver reports for one MCP server: its name, bounded where the driver read it from
/// provider output, its reading and the provider's own error text. It carries no leg identity:
/// the producer it goes to is bound to the leg at spawn, so a driver cannot report for another leg.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpServerStatusEmission {
    /// The server's name.
    pub(crate) server_name: McpServerName,
    /// What the provider reported.
    pub(crate) reading: McpServerReading,
    /// The provider's error text for the server, untrusted and cut to the error-message cap; it
    /// is not sanitized here.
    pub(crate) failure_text: Option<String>,
}

/// One server's reading as the daemon reads it, stamped with the leg the producer was bound to.
/// A run has many bindings, so readings key per binding and server: a relaunched leg's census
/// replaces its predecessor's without touching a live leg's rows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpServerStatusUpdate {
    /// The session.
    pub session_id: SessionId,
    /// The binding the producer was bound to.
    pub binding_id: RuntimeBindingId,
    /// The server's name.
    pub server_name: McpServerName,
    /// What the provider reported.
    pub reading: McpServerReading,
    /// The provider's error text for the server, untrusted and cut to the error-message cap; the
    /// daemon sanitizes it before it leaves.
    pub failure_text: Option<String>,
}

impl McpServerStatusUpdate {
    /// Stamps a driver's emission with the session and binding of the leg its producer was bound
    /// to.
    pub fn new(
        session_id: SessionId,
        binding_id: RuntimeBindingId,
        emission: McpServerStatusEmission,
    ) -> Self {
        Self {
            session_id,
            binding_id,
            server_name: emission.server_name,
            reading: emission.reading,
            failure_text: emission.failure_text,
        }
    }
}

/// The status sink the daemon hands a driver, bound to the leg at spawn. It returns nothing and
/// is never awaited, so a slow reader cannot hold back the provider's status stream.
pub type McpServerStatusProducer = Arc<dyn Fn(McpServerStatusEmission) + Send + Sync>;

/// A raw row, line or notification a driver's status reader could not turn into a bounded
/// emission. It is returned, never dropped, so a malformed row shows as a visible gap.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct McpServerStatusIngestRejection {
    /// Why the row was refused.
    pub(crate) reason: String,
}

/// What a driver's status reader made of one raw payload: the bounded emissions and the rows it
/// refused.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct McpServerStatusIngestResult {
    /// The rows that passed the bound.
    pub(crate) emissions: Vec<McpServerStatusEmission>,
    /// The rows refused, each with its reason.
    pub(crate) rejections: Vec<McpServerStatusIngestRejection>,
}

/// Bounds one reported server: its name, its reading and its raw error text. The name is
/// untrusted provider output: one that is not text, is blank, holds a NUL or passes its length
/// bound comes back as a rejection instead of reaching the leg's producer. The error text is kept
/// as sent, cut to the error-message cap in code points; one that is absent, not text or blank
/// after the cut reads `None`.
pub(crate) fn bound_mcp_server_status_emission(
    server_name: &Value,
    reading: McpServerReading,
    raw_failure_text: &Value,
) -> Result<McpServerStatusEmission, McpServerStatusIngestRejection> {
    let Some(server_name) = server_name.as_str() else {
        return Err(McpServerStatusIngestRejection {
            reason: "MCP server-status emission rejected at the wire bound: the server name is \
                     not text"
                .to_owned(),
        });
    };
    let failure_text = raw_failure_text
        .as_str()
        .map(|text| cut_to_code_points(text, ERROR_MESSAGE_MAX_LEN))
        .filter(|text| !text.chars().all(is_ecmascript_whitespace))
        .map(str::to_owned);
    FreeFormText::new(server_name.to_owned())
        .map(|server_name| McpServerStatusEmission {
            server_name,
            reading,
            failure_text,
        })
        .map_err(|text_failure| McpServerStatusIngestRejection {
            reason: format!(
                "MCP server-status emission rejected at the wire bound: the server name: \
                 {text_failure}"
            ),
        })
}
