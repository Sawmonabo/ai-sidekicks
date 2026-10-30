//! An MCP server's reading as a driver reports it for its session leg, the bound every driver's
//! status reader puts a reported row through, and the leg-stamped update the daemon reads, keyed
//! per binding and server.

use std::sync::Arc;

use serde_json::Value;
use sidekicks_contracts::error::ERROR_MESSAGE_MAX_LEN;
use sidekicks_contracts::mcp::server::{McpServerName, McpServerStatus, McpToolName};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::{FreeFormText, is_ecmascript_whitespace};
use sidekicks_ipc::redaction::sanitize_failure_reason;

/// The most code points of a provider's error text a reading keeps: room past the error-message
/// cap a notice applies when it sends the text.
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
/// provider output, its reading, the provider's own error text and the server's tool names where
/// the report lists them. It carries no leg identity:
/// the producer it goes to is bound to the leg at spawn, so a driver cannot report for another leg.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpServerStatusEmission {
    /// The server's name.
    pub(crate) server_name: McpServerName,
    /// What the provider reported.
    pub(crate) reading: McpServerReading,
    /// The provider's error text for the server, untrusted, sanitized before it was cut to a
    /// bound: its credentials, URL queries and paths outside a web address replaced.
    pub(crate) failure_text: Option<String>,
    /// The names of the server's tools; `None` where the report carries no list, which is no
    /// claim that the server has none.
    pub(crate) tool_names: Option<Vec<McpToolName>>,
}

impl McpServerStatusEmission {
    /// The server's name, which the daemon attributes to the binding a session serves it from.
    pub fn server_name(&self) -> &McpServerName {
        &self.server_name
    }

    /// An emission as a driver's status reader builds one, for the tests of the crates that
    /// apply emissions.
    #[cfg(any(test, feature = "test-support"))]
    pub fn new(
        server_name: McpServerName,
        reading: McpServerReading,
        failure_text: Option<String>,
        tool_names: Option<Vec<McpToolName>>,
    ) -> Self {
        Self {
            server_name,
            reading,
            failure_text,
            tool_names,
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
    /// The provider's error text for the server, untrusted, sanitized and cut to a bound.
    pub failure_text: Option<String>,
    /// The names of the server's tools; `None` where the report carries no list.
    pub tool_names: Option<Vec<McpToolName>>,
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
            tool_names: emission.tool_names,
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

/// Bounds one reported server: its name, its reading and its raw error text, carrying the tool
/// names the report lists, `None` where it lists none. The name is untrusted provider output: one
/// that is not text, is blank, holds a NUL or passes its length bound comes back as a rejection
/// instead of reaching the leg's producer. The error text has its credentials scrubbed, its URL
/// queries stripped and its paths outside a web address redacted whole, so a cut cannot split one
/// past the sanitizer's reach, and is then capped in code points; one that is absent, not text or
/// blank after the cap reads `None`.
pub(crate) fn bound_mcp_server_status_emission(
    server_name: &Value,
    reading: McpServerReading,
    raw_failure_text: &Value,
    tool_names: Option<Vec<McpToolName>>,
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
        .map(|text| sanitize_failure_reason(text, FAILURE_TEXT_MAX_CODE_POINTS))
        .filter(|text| !text.chars().all(is_ecmascript_whitespace));
    FreeFormText::new(server_name.to_owned())
        .map(|server_name| McpServerStatusEmission {
            server_name,
            reading,
            failure_text,
            tool_names,
        })
        .map_err(|text_failure| McpServerStatusIngestRejection {
            reason: format!(
                "MCP server-status emission rejected at the wire bound: the server name: \
                 {text_failure}"
            ),
        })
}

/// `error` and each of its causes, joined by `: ` and sanitized as a provider's error text is,
/// so it can stand as a server's failure text; it never quotes a credential, a URL's query or an
/// absolute path.
pub(crate) fn sanitize_failure_chain(error: &(dyn std::error::Error + 'static)) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    sanitize_failure_reason(&text, FAILURE_TEXT_MAX_CODE_POINTS)
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};
    use sidekicks_contracts::mcp::server::McpServerStatus;

    use super::{FAILURE_TEXT_MAX_CODE_POINTS, McpServerReading, bound_mcp_server_status_emission};

    // The error text leaves the bound with no credential, URL query or path: a token that straddles
    // the bound is scrubbed whole, since cut first its prefix would fall under the token pattern's
    // minimum length, and a program's path and a signed address's query are gone while the
    // address's host and path stay. Killed by the scrub, the query strip or the path redaction
    // dropped, and by the cut taken before them.
    #[test]
    fn a_failure_text_is_sanitized_whole_before_the_cut() {
        let bound = |raw: String| {
            bound_mcp_server_status_emission(
                &json!("github"),
                McpServerReading::Observed(McpServerStatus::Failed),
                &Value::String(raw),
                None,
            )
            .expect("the row passes the bound")
            .failure_text
            .expect("the error text is kept")
        };

        let straddling = bound(format!(
            "{} ghp_abcdefghijklmnop",
            "x".repeat(FAILURE_TEXT_MAX_CODE_POINTS - 8)
        ));
        assert!(!straddling.contains("ghp_"), "the token's prefix is kept");
        assert!(
            straddling.ends_with("***"),
            "{}",
            &straddling[straddling.len() - 16..]
        );

        let located = bound(
            "spawn /Users/alice/bin/notes-server ENOENT; SSE error at \
             https://mcp.example.com/sse?sig=signed-secret-value"
                .to_owned(),
        );
        for kept in [
            "/Users/alice",
            "notes-server",
            "sig=",
            "signed-secret-value",
        ] {
            assert!(!located.contains(kept), "{kept} is kept: {located}");
        }
        assert!(located.contains("https://mcp.example.com/sse"), "{located}");
    }
}
