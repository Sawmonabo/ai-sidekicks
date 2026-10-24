//! The control frames a Claude Code process writes: the requests it sends the daemon and waits on,
//! its withdrawal of one, and its answers to the daemon's own requests. Each is read into structs
//! that name only the members read, the members relayed unread kept as raw JSON, so a frame nested
//! at any depth reads; a request is read by its `subtype` first, then by that subtype's own struct.
//! A frame nothing can take is recorded, since its sender waits on an answer that never comes.

use serde::{Deserialize, Serialize};
use serde_json::Map;
use serde_json::value::RawValue;
use sidekicks_contracts::provider::account::record::ProviderAccountId;

use crate::provider::driver::claude::DESCRIPTOR;
use crate::provider::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, OnceReportedDiagnostics, emit_driver_diagnostic,
};
use crate::provider::lenient_json::{Lenient, LenientList, lenient_object, read_lenient};

// The request subtypes Claude Code sends that the daemon knowingly leaves pending: an MCP
// elicitation.
const PENDING_REQUEST_SUBTYPES: &[&str] = &["elicitation"];

/// What arrives on a process's request stream: a request, or Claude Code withdrawing one. It
/// crosses from the process's reader to the session's task by value, the reader never waiting.
#[derive(Debug)]
pub(crate) enum ClaudeInboundRequestEvent {
    /// A request the process waits on.
    Request(ClaudeInboundRequest),
    /// The process withdrew the request `request_id`.
    Cancel {
        /// The withdrawn request's id.
        request_id: String,
    },
}

/// One request Claude Code sent, under the id its answer goes back with; untrusted.
#[derive(Debug)]
pub(crate) struct ClaudeInboundRequest {
    /// The id the answer goes back under.
    pub(crate) request_id: String,
    /// What it asks.
    pub(crate) body: ClaudeInboundRequestBody,
}

/// What a request asks, by its subtype.
#[derive(Debug)]
pub(crate) enum ClaudeInboundRequestBody {
    /// Whether a tool call may run.
    CanUseTool(ClaudeToolUseAsk),
    /// One of the daemon's own hooks fired.
    HookCallback(ClaudeHookCallback),
    /// A choice Claude Code asks the person.
    RequestUserDialog(ClaudeUserDialog),
    /// A message for a tool server the daemon hosts in-process, answered with a
    /// [`ClaudeMcpMessageAnswer`].
    McpMessage(ClaudeMcpMessage),
    /// A request the daemon does not answer, which stays pending at the provider.
    Unrouted {
        /// Its subtype, as sent.
        subtype: String,
    },
}

/// The members of a `can_use_tool` request a tool ask reads.
#[derive(Debug, Deserialize)]
pub(crate) struct ClaudeToolUseAsk {
    /// The tool.
    #[serde(default, deserialize_with = "read_lenient")]
    pub(crate) tool_name: Option<String>,
    /// The call's input, relayed as sent.
    #[serde(default)]
    pub(crate) input: Option<Box<RawValue>>,
    /// The call's id.
    #[serde(default, deserialize_with = "read_lenient")]
    pub(crate) tool_use_id: Option<String>,
    /// The helper that asks, absent for the lead.
    #[serde(default, deserialize_with = "read_lenient")]
    pub(crate) agent_id: Option<String>,
    /// The ask's own words, where Claude Code wrote any.
    #[serde(default, deserialize_with = "read_lenient")]
    pub(crate) title: Option<String>,
    /// The ask's description, where Claude Code wrote one.
    #[serde(default, deserialize_with = "read_lenient")]
    pub(crate) description: Option<String>,
    /// What sent the call to an ask: a rule, a mode, a safety check.
    #[serde(default, deserialize_with = "read_lenient")]
    pub(crate) decision_reason_type: Option<String>,
    /// Whether Claude Code's own safety check flagged the call, so no standing allow answers it.
    #[serde(default, deserialize_with = "read_lenient")]
    pub(crate) suppress_always_allow_rule: Option<bool>,
}

/// The members of a `hook_callback` request the daemon's hooks read.
#[derive(Debug, Deserialize)]
pub(crate) struct ClaudeHookCallback {
    /// The callback id the hook was registered under.
    #[serde(default, deserialize_with = "read_lenient")]
    pub(crate) callback_id: Option<String>,
    /// The call the hook fired for.
    #[serde(default, deserialize_with = "read_lenient")]
    pub(crate) tool_use_id: Option<String>,
    /// The hook's input, relayed as sent.
    #[serde(default)]
    pub(crate) input: Option<Box<RawValue>>,
}

/// The members of a `request_user_dialog` request.
#[derive(Debug, Deserialize)]
pub(crate) struct ClaudeUserDialog {
    /// Which choice it asks, one of the kinds `initialize` declared.
    #[serde(default, deserialize_with = "read_lenient")]
    pub(crate) dialog_kind: Option<String>,
    /// What the choice shows, relayed as sent.
    #[serde(default)]
    pub(crate) payload: Option<Box<RawValue>>,
}

/// The members of an `mcp_message` request.
#[derive(Debug, Deserialize)]
pub(crate) struct ClaudeMcpMessage {
    /// The server, as `initialize` or `mcp_set_servers` named it.
    #[serde(default, deserialize_with = "read_lenient")]
    pub(crate) server_name: Option<String>,
    /// The JSON-RPC message for it, relayed as sent.
    #[serde(default)]
    pub(crate) message: Option<Box<RawValue>>,
}

/// The success an `mcp_message` request is answered with: the server's JSON-RPC reply.
#[derive(Debug, Serialize)]
pub(crate) struct ClaudeMcpMessageAnswer {
    /// The reply, relayed as the server wrote it.
    pub(crate) mcp_response: Box<RawValue>,
}

/// One answer Claude Code sent to a control request of the daemon's.
#[derive(Debug)]
pub(crate) struct ClaudeControlResponse {
    /// The id the request was written under, as sent.
    pub(crate) request_id: String,
    /// The answer.
    pub(crate) outcome: ClaudeControlOutcome,
}

/// A control request's answer: success with its payload, or Claude Code's refusal in its words.
#[derive(Debug)]
pub(crate) enum ClaudeControlOutcome {
    /// The request was carried out.
    Success(ClaudeControlAnswer),
    /// Claude Code refused it; a consumer classifies the refusal by the request's subtype and
    /// never by these words.
    Refused {
        /// Claude Code's words.
        error: String,
    },
}

/// A successful control answer: its payload, and the dialogs the process still waits on.
#[derive(Debug, Default)]
pub(crate) struct ClaudeControlAnswer {
    /// The answer's payload, relayed as sent.
    pub(crate) response: Option<Box<RawValue>>,
    /// The ids of the dialogs the process is still blocked on, where the answer lists them.
    pub(crate) pending_user_dialog_requests: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct ControlRequestFrame {
    #[serde(default, deserialize_with = "read_lenient")]
    request_id: Option<String>,
    #[serde(default)]
    request: Option<Box<RawValue>>,
}

#[derive(Deserialize)]
struct RequestSubtype {
    #[serde(default, deserialize_with = "read_lenient")]
    subtype: Option<String>,
}

#[derive(Deserialize)]
struct ControlCancelFrame {
    #[serde(default, deserialize_with = "read_lenient")]
    request_id: Option<String>,
}

#[derive(Deserialize)]
struct ControlResponseFrame {
    #[serde(default, deserialize_with = "read_lenient")]
    response: Option<ControlResponseBody>,
}

#[derive(Deserialize)]
struct ControlResponseBody {
    #[serde(default, deserialize_with = "read_lenient")]
    subtype: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    request_id: Option<String>,
    #[serde(default)]
    response: Option<Box<RawValue>>,
    #[serde(default, deserialize_with = "read_lenient")]
    error: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    pending_user_dialog_requests: Option<LenientList<PendingRequest>>,
}

#[derive(Deserialize)]
struct PendingRequest {
    #[serde(default, deserialize_with = "read_lenient")]
    request_id: Option<String>,
}

lenient_object!(
    ClaudeToolUseAsk,
    ClaudeHookCallback,
    ClaudeUserDialog,
    ClaudeMcpMessage,
    ControlRequestFrame,
    RequestSubtype,
    ControlCancelFrame,
    ControlResponseFrame,
    ControlResponseBody,
    PendingRequest,
);

/// Reads one process's control frames, recording each it cannot take, and each request subtype
/// it does not know once per subtype for the process's life.
pub(crate) struct ClaudeControlFrameReader {
    provider_account_id: Option<ProviderAccountId>,
    provider_session_id: String,
    once_reported: OnceReportedDiagnostics,
}

impl ClaudeControlFrameReader {
    /// A reader for the process running `provider_session_id` on `provider_account_id`'s home.
    pub(crate) fn new(
        provider_account_id: Option<ProviderAccountId>,
        provider_session_id: String,
    ) -> Self {
        Self {
            provider_account_id,
            provider_session_id,
            once_reported: OnceReportedDiagnostics::default(),
        }
    }

    /// Reads a `control_request` frame's text; `None`, recorded, when it names no id or subtype.
    pub(crate) fn read_request(&mut self, frame: &str) -> Option<ClaudeInboundRequestEvent> {
        let read = read_object::<ControlRequestFrame>(frame);
        let request_id = read.as_ref().and_then(|frame| frame.request_id.clone());
        let request = read.and_then(|frame| frame.request);
        let subtype = request
            .as_deref()
            .and_then(|request| read_object::<RequestSubtype>(request.get()))
            .and_then(|request| request.subtype);
        let (Some(request_id), Some(request), Some(subtype)) = (request_id, request, subtype)
        else {
            self.report_malformed("control_request");
            return None;
        };
        let body = match subtype.as_str() {
            "can_use_tool" => read_body(&request, ClaudeInboundRequestBody::CanUseTool),
            "hook_callback" => read_body(&request, ClaudeInboundRequestBody::HookCallback),
            "request_user_dialog" => {
                read_body(&request, ClaudeInboundRequestBody::RequestUserDialog)
            }
            "mcp_message" => read_body(&request, ClaudeInboundRequestBody::McpMessage),
            known if PENDING_REQUEST_SUBTYPES.contains(&known) => None,
            unknown => {
                self.once_reported.report(&self.record(
                    DriverDiagnosticKind::UnmappedWireKind,
                    format!("control_request/{unknown}"),
                    "a control request of a subtype the daemon does not know stays pending",
                ));
                None
            }
        }
        .unwrap_or(ClaudeInboundRequestBody::Unrouted { subtype });
        Some(ClaudeInboundRequestEvent::Request(ClaudeInboundRequest {
            request_id,
            body,
        }))
    }

    /// Reads a `control_cancel_request` frame's text; `None`, recorded, when it names no id.
    pub(crate) fn read_cancel(&mut self, frame: &str) -> Option<ClaudeInboundRequestEvent> {
        if let Some(request_id) =
            read_object::<ControlCancelFrame>(frame).and_then(|frame| frame.request_id)
        {
            return Some(ClaudeInboundRequestEvent::Cancel { request_id });
        }
        self.report_malformed("control_cancel_request");
        None
    }

    /// Reads a `control_response` frame's text; `None`, recorded, when it names no request id.
    pub(crate) fn read_response(&mut self, frame: &str) -> Option<ClaudeControlResponse> {
        let Some((body, request_id)) = read_object::<ControlResponseFrame>(frame)
            .and_then(|frame| frame.response)
            .and_then(|mut body| body.request_id.take().map(|request_id| (body, request_id)))
        else {
            self.report_malformed("control_response");
            return None;
        };
        let outcome = if body.subtype.as_deref() == Some("error") {
            ClaudeControlOutcome::Refused {
                error: body.error.unwrap_or_default(),
            }
        } else {
            ClaudeControlOutcome::Success(ClaudeControlAnswer {
                response: body.response,
                pending_user_dialog_requests: body.pending_user_dialog_requests.map(|pending| {
                    pending
                        .0
                        .into_iter()
                        .filter_map(|entry| entry.request_id)
                        .collect()
                }),
            })
        };
        Some(ClaudeControlResponse {
            request_id,
            outcome,
        })
    }

    /// Records an answer for an id this process never issued, which says the process is broken.
    pub(crate) fn report_unissued_answer(&self) {
        emit_driver_diagnostic(&self.record(
            DriverDiagnosticKind::ControlFrameMalformed,
            "control_response".to_owned(),
            "an answer for a control request id this process never issued was dropped",
        ));
    }

    fn report_malformed(&self, raw_wire_type: &str) {
        emit_driver_diagnostic(&self.record(
            DriverDiagnosticKind::ControlFrameMalformed,
            raw_wire_type.to_owned(),
            "a control frame with no request id or subtype was dropped",
        ));
    }

    fn record(
        &self,
        kind: DriverDiagnosticKind,
        raw_wire_type: String,
        disposition_reason: &str,
    ) -> DriverDiagnosticRecord {
        let mut details = Map::new();
        details.insert(
            "providerSessionId".to_owned(),
            self.provider_session_id.clone().into(),
        );
        DriverDiagnosticRecord {
            provider: DESCRIPTOR.provider_id(),
            provider_account_id: self.provider_account_id.clone(),
            kind,
            raw_wire_type: Some(raw_wire_type),
            disposition_reason: disposition_reason.to_owned(),
            details,
        }
    }
}

// A request's own struct, read from its whole `request` member.
fn read_body<Body: Lenient>(
    request: &RawValue,
    arm: impl FnOnce(Body) -> ClaudeInboundRequestBody,
) -> Option<ClaudeInboundRequestBody> {
    read_object::<Body>(request.get()).map(arm)
}

// `text`, provider JSON, read as `Shape` when it is an object; `None` for anything else.
fn read_object<Shape: Lenient>(text: &str) -> Option<Shape> {
    let mut deserializer = serde_json::Deserializer::from_str(text);
    Shape::read(&mut deserializer)
        .ok()
        .flatten()
        .filter(|_| deserializer.end().is_ok())
}

#[cfg(test)]
mod tests {
    use super::{ClaudeControlFrameReader, ClaudeInboundRequestBody, ClaudeInboundRequestEvent};

    // Far past `serde_json`'s 128-level limit, which a member read into a `Value` would hit.
    const INPUT_DEPTH: usize = 10_000;

    // Killed by reading a relayed member into a `Value`, or by any recursion over it: the frame's
    // input nests far past the decoder's own limit and the request still reads, input whole.
    #[test]
    fn a_request_whose_input_nests_deep_reads_whole() {
        let input = format!("{}{}", "[".repeat(INPUT_DEPTH), "]".repeat(INPUT_DEPTH));
        let frame = format!(
            concat!(
                r#"{{"type":"control_request","request_id":"7","#,
                r#""request":{{"subtype":"can_use_tool","tool_name":"Bash","input":{input}}}}}"#
            ),
            input = input
        );
        let mut reader = ClaudeControlFrameReader::new(None, "session".to_owned());

        let Some(ClaudeInboundRequestEvent::Request(request)) = reader.read_request(&frame) else {
            panic!("the request reads");
        };

        let ClaudeInboundRequestBody::CanUseTool(ask) = request.body else {
            panic!("the request is a tool ask");
        };
        assert_eq!(request.request_id, "7");
        assert_eq!(ask.tool_name.as_deref(), Some("Bash"));
        assert_eq!(ask.input.map(|input| input.get().len()), Some(input.len()));
    }
}
