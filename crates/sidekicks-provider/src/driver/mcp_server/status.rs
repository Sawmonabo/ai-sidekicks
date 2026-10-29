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
use sidekicks_ipc::redaction::scrub_credentials;
use sidekicks_std::text_cut::cut_to_code_points;

/// The most code points of a provider's error text a reading keeps: room past the error-message
/// cap, which the daemon's sanitizer applies once paths and queries are gone.
const FAILURE_TEXT_MAX_CODE_POINTS: usize = 4 * ERROR_MESSAGE_MAX_LEN;

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
    /// The provider's error text for the server, untrusted, its credentials scrubbed before it
    /// was cut to a bound; the rest of the sanitizing happens when it leaves the daemon.
    pub(crate) failure_text: Option<String>,
}

#[cfg(any(test, feature = "test-support"))]
impl McpServerStatusEmission {
    /// An emission as a driver's status reader builds one, for the tests of the crates that
    /// apply emissions.
    pub fn new(
        server_name: McpServerName,
        reading: McpServerReading,
        failure_text: Option<String>,
    ) -> Self {
        Self {
            server_name,
            reading,
            failure_text,
        }
    }
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
    /// The provider's error text for the server, untrusted, its credentials scrubbed and cut to a
    /// bound; the daemon sanitizes the rest before it leaves.
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

/// The status sink the daemon hands a driver, bound to the leg at spawn. Neither method returns
/// anything or is awaited, so a slow reader cannot hold back the provider's status stream.
pub trait McpServerStatusSink: Send + Sync {
    /// Reports what the provider said about one server on the sink's leg.
    fn report_status(&self, emission: McpServerStatusEmission);

    /// Ends the sink's leg: the driver calls it once, as the leg's provider process ends, and the
    /// daemon retires the leg's rows.
    fn end_leg(&self);
}

/// The status sink a driver's carriers hold, shared between the readers of one leg.
pub type McpServerStatusProducer = Arc<dyn McpServerStatusSink>;

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
/// bound comes back as a rejection instead of reaching the leg's producer. The error text has its
/// credentials scrubbed whole, so a cut cannot split one past the scrub's reach, and is then cut
/// to a bound in code points; one that is absent, not text or blank after the cut reads `None`.
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
        .map(scrub_credentials)
        .map(|text| cut_to_code_points(&text, FAILURE_TEXT_MAX_CODE_POINTS).to_owned())
        .filter(|text| !text.chars().all(is_ecmascript_whitespace));
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

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};
    use sidekicks_contracts::mcp::server::McpServerStatus;

    use super::{FAILURE_TEXT_MAX_CODE_POINTS, McpServerReading, bound_mcp_server_status_emission};

    // A token that straddles the bound is scrubbed whole: cut first, its prefix would fall under
    // the token pattern's minimum length and reach the daemon as text.
    #[test]
    fn a_credential_across_the_bound_is_scrubbed_before_the_cut() {
        let raw = format!(
            "{} ghp_abcdefghijklmnop",
            "x".repeat(FAILURE_TEXT_MAX_CODE_POINTS - 8)
        );

        let emission = bound_mcp_server_status_emission(
            &json!("github"),
            McpServerReading::Observed(McpServerStatus::Failed),
            &Value::String(raw),
        )
        .expect("the row passes the bound");

        let failure_text = emission.failure_text.expect("the error text is kept");
        assert!(!failure_text.contains("ghp_"), "the token's prefix is kept");
        assert!(
            failure_text.ends_with("***"),
            "{}",
            &failure_text[failure_text.len() - 16..]
        );
    }
}
