//! The requests a Codex service sends the daemon on one connection: each routed ask answered
//! through the responder or held for the person, every other request answered `-32601`, and the
//! held asks answered, found and let go of by their request id.

use std::error::Error;
use std::sync::{Arc, LazyLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use serde_json::value::RawValue;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::error_description::describe_error;
use crate::provider::driver::codex::server_requests::{
    CODEX_OUTBOUND_ANSWER_TOO_LARGE_REASON, CodexAskKind, CodexInboundServerRequest,
    CodexRoutedMethod, CodexServerRequestAnswer, CodexServerRequestDecision, CodexUnadjudicatedAsk,
    compose_unrouted_request_error, is_codex_server_request_method,
};
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::transport::connection::{
    CodexAppServerConnection, CodexForgottenRequest, ConnectionShared, JSON_RPC_VERSION,
    read_codex_object, read_member,
};
use crate::provider::driver::codex::transport::diagnostics::CodexTransportDiagnostic;
use crate::provider::driver::contract::bound_failure_detail;

/// Stands in for a responder failure that carries no words, as the refusal's reason.
static RESPONDER_FAILURE_FALLBACK: LazyLock<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>> =
    LazyLock::new(|| {
        FreeFormText::new("The daemon's answer to this request failed.".to_owned())
            .expect("the fallback is non-blank and within the cap")
    });

/// An ask the responder held, answered later by its request id.
pub(super) struct HeldServerRequest {
    /// The service's id, echoed as sent.
    id: Box<RawValue>,
    /// The routed method.
    method: CodexRoutedMethod,
    /// The ask's params as sent.
    params: Box<RawValue>,
}

// The members of a held ask's params that name its conversation and turn; an older approval
// names its conversation `conversationId`.
#[expect(
    clippy::struct_field_names,
    reason = "each member is the id of what it names"
)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AskConversation {
    thread_id: Option<Box<RawValue>>,
    turn_id: Option<Box<RawValue>>,
    conversation_id: Option<Box<RawValue>>,
}

#[derive(Serialize)]
struct OutboundResult<'message> {
    jsonrpc: &'static str,
    id: &'message RawValue,
    result: &'message Value,
}

#[derive(Serialize)]
struct OutboundError<'message> {
    jsonrpc: &'static str,
    id: &'message RawValue,
    error: &'message Value,
}

#[expect(
    dead_code,
    reason = "the Codex ask delivery answers, finds and lets go of the asks held for the person"
)]
impl CodexAppServerConnection {
    /// Answers an ask held for the person with `answer`, in the asking method's own shape. Fails
    /// with `CodexError::Transport` when no ask is held under `request_id` or another answer to it
    /// is being sent, or when `answer` does not fit the ask (the ask stays held for one that
    /// does), and as a send fails otherwise, the ask staying held for another answer.
    /// `request_id` is the request id's JSON text, as `CodexInboundServerRequest::request_id`
    /// carries it.
    pub(crate) async fn answer_held_request(
        &self,
        request_id: &str,
        answer: &CodexServerRequestAnswer,
    ) -> Result<(), CodexError> {
        let (id, method, result) = {
            let mut state = self.shared.lock_state();
            let held = state
                .held
                .get(request_id)
                .filter(|_| !state.answering.contains(request_id))
                .ok_or_else(|| CodexError::Transport {
                    detail: format!("No Codex request {request_id} is waiting for an answer."),
                    cause: None,
                })?;
            let result = held
                .method
                .compose_answer_result(&held.params, answer)
                .ok_or_else(|| CodexError::Transport {
                    detail: format!(
                        "The answer does not fit the Codex request {request_id}, which stays held."
                    ),
                    cause: None,
                })?;
            let held = (held.id.clone(), held.method, result);
            state.answering.insert(request_id.to_owned());
            held
        };
        let mut answering = AnsweringHeldRequest {
            shared: &self.shared,
            request_id,
            is_sent: false,
        };
        self.shared.send_answer(&id, method, &result).await?;
        answering.is_sent = true;
        Ok(())
    }

    /// Whether this connection holds an ask under `request_id` for the person. `request_id` is the
    /// request id's JSON text, as `CodexInboundServerRequest::request_id` carries it.
    pub(crate) fn holds_request(&self, request_id: &str) -> bool {
        self.shared.lock_state().held.contains_key(request_id)
    }

    /// Lets go of a held ask Codex settled itself, so no answer is sent for it later. Answers who
    /// the ask was for, or `None` when none was held under `request_id`. `request_id` is the
    /// request id's JSON text, as `CodexInboundServerRequest::request_id` carries it.
    pub(crate) fn forget_held_request(&self, request_id: &str) -> Option<CodexAskKind> {
        let mut state = self.shared.lock_state();
        state.answering.remove(request_id);
        let held = state.held.remove(request_id)?;
        Some(held.method.classify_ask(&held.params))
    }

    /// Lets go of every held ask the turn `turn_id` of conversation `thread_id` made, since
    /// nothing can answer it once the turn ended. Answers each one let go of.
    pub(crate) fn forget_held_requests_of_turn(
        &self,
        thread_id: &str,
        turn_id: &str,
    ) -> Vec<CodexForgottenRequest> {
        self.shared
            .lock_state()
            .held
            .extract_if(|_, held| {
                read_codex_object::<AskConversation>(held.params.get()).is_some_and(|names| {
                    read_member::<String>(names.thread_id.as_deref()).as_deref() == Some(thread_id)
                        && read_member::<String>(names.turn_id.as_deref()).as_deref()
                            == Some(turn_id)
                })
            })
            .map(|(request_id, held)| CodexForgottenRequest {
                request_id,
                ask_kind: held.method.classify_ask(&held.params),
                thread_id: Some(thread_id.to_owned()),
            })
            .collect()
    }
}

/// A held ask whose answer is being sent: once sent the ask is let go of, otherwise it stays
/// held for another answer.
struct AnsweringHeldRequest<'connection> {
    shared: &'connection ConnectionShared,
    request_id: &'connection str,
    is_sent: bool,
}

impl Drop for AnsweringHeldRequest<'_> {
    fn drop(&mut self) {
        let mut state = self.shared.lock_state();
        state.answering.remove(self.request_id);
        if self.is_sent {
            state.held.remove(self.request_id);
        }
    }
}

impl ConnectionShared {
    // Answers a request outside the routed table `-32601`, known to the protocol or not: an error
    // cannot be read as consent, and silence would hang the turn.
    pub(super) async fn refuse_unrouted_request(
        self: Arc<Self>,
        id: Box<RawValue>,
        method: String,
    ) {
        CodexTransportDiagnostic::UnhandledServerRequest {
            is_in_protocol: is_codex_server_request_method(&method),
            method: method.clone(),
        }
        .report();
        let unrouted_error = compose_unrouted_request_error();
        let sent = match serde_json::to_string(&OutboundError {
            jsonrpc: JSON_RPC_VERSION,
            id: &id,
            error: &unrouted_error,
        }) {
            Ok(text) => self.send_text(&method, text).await,
            Err(error) => Err(encoding_failure(error)),
        };
        if let Err(error) = sent {
            report_answer_write_failure(&method, error);
        }
    }

    // Answers one routed ask through the responder, or holds it for the person. An ask with no
    // responder, a failing one, or an answer that does not fit it answers the method's own
    // refusal, never `-32601` and never an allow.
    pub(super) async fn answer_routed_request(
        self: Arc<Self>,
        id: Box<RawValue>,
        method: CodexRoutedMethod,
        params: Box<RawValue>,
    ) {
        // Keyed by its JSON, so a string id and a number with the same digits stay apart.
        let request_id = id.get().to_owned();
        let result = match &self.responder {
            None => {
                CodexTransportDiagnostic::UnroutedServerRequestRefused {
                    method: method.method().to_owned(),
                }
                .report();
                method.compose_unadjudicated_result(CodexUnadjudicatedAsk::NoResponder)
            }
            Some(responder) => {
                let request = CodexInboundServerRequest {
                    request_id: request_id.clone(),
                    method,
                    ask_kind: method.classify_ask(&params),
                    params: params.clone(),
                };
                match responder.answer(request).await {
                    Ok(CodexServerRequestDecision::Held { on_held }) => {
                        self.hold_request(request_id, HeldServerRequest { id, method, params });
                        if let Some(on_held) = on_held {
                            on_held();
                        }
                        return;
                    }
                    Ok(CodexServerRequestDecision::Answer(answer)) => {
                        match method.compose_answer_result(&params, &answer) {
                            Some(result) => result,
                            None => refuse_undecided(
                                method,
                                "The daemon's answer does not fit this request.".into(),
                            ),
                        }
                    }
                    Err(error) => refuse_undecided(method, Box::new(error)),
                }
            }
        };
        if let Err(error) = self.send_answer(&id, method, &result).await {
            // A failed answer leaves the service waiting on the ask.
            report_answer_write_failure(method.method(), error);
        }
    }

    // Holds an ask for the person. A connection that closed while the ask was handed on reports
    // it let go of at once, so its card is withdrawn like the others; `on_held` then never runs,
    // since nothing holds it.
    fn hold_request(&self, request_id: String, held: HeldServerRequest) {
        let mut state = self.lock_state();
        if state.close_reason.is_none() {
            state.held.insert(request_id, held);
            return;
        }
        drop(state);
        self.events
            .held_requests_dropped(vec![read_dropped_request(request_id, &held)]);
    }

    // Sends one answer within the largest message the service takes, measured on its encoded
    // bytes. An answer past it becomes the method's refusal, never a cut answer, and a refusal
    // past it too sends nothing.
    async fn send_answer(
        &self,
        id: &RawValue,
        method: CodexRoutedMethod,
        result: &Value,
    ) -> Result<(), CodexError> {
        let text = encode_answer(id, result)?;
        let limit = self.sent_message_byte_limit;
        if text.len() <= limit {
            return self.send_text(method.method(), text).await;
        }
        report_oversized_answer(method, text.len(), limit);
        let refusal = encode_answer(
            id,
            &method.compose_refused_result(CODEX_OUTBOUND_ANSWER_TOO_LARGE_REASON),
        )?;
        if refusal.len() <= limit {
            return self.send_text(method.method(), refusal).await;
        }
        // Reachable only when the service's own request id is past the limit.
        report_oversized_answer(method, refusal.len(), limit);
        Ok(())
    }
}

/// A held ask as the connection lets go of it, with the conversation it names.
pub(super) fn read_dropped_request(
    request_id: String,
    held: &HeldServerRequest,
) -> CodexForgottenRequest {
    let thread_id = read_codex_object::<AskConversation>(held.params.get()).and_then(|names| {
        read_member::<String>(names.thread_id.or(names.conversation_id).as_deref())
    });
    CodexForgottenRequest {
        request_id,
        ask_kind: held.method.classify_ask(&held.params),
        thread_id: thread_id.filter(|thread_id| !thread_id.is_empty()),
    }
}

// The method's refusal for an ask its responder did not decide, the failure reported and its
// words, bounded, the refusal's reason.
fn refuse_undecided(method: CodexRoutedMethod, error: Box<dyn Error + Send + Sync>) -> Value {
    let detail = bound_failure_detail(&describe_error(&*error), RESPONDER_FAILURE_FALLBACK.clone());
    CodexTransportDiagnostic::ServerRequestResponderFailed {
        method: method.method().to_owned(),
        error,
    }
    .report();
    method.compose_unadjudicated_result(CodexUnadjudicatedAsk::ResponderFailed {
        detail: detail.as_str(),
    })
}

fn encode_answer(id: &RawValue, result: &Value) -> Result<String, CodexError> {
    serde_json::to_string(&OutboundResult {
        jsonrpc: JSON_RPC_VERSION,
        id,
        result,
    })
    .map_err(encoding_failure)
}

fn encoding_failure(error: serde_json::Error) -> CodexError {
    CodexError::Transport {
        detail: "An answer to the Codex service could not be encoded.".to_owned(),
        cause: Some(Box::new(error)),
    }
}

fn report_answer_write_failure(method: &str, error: CodexError) {
    CodexTransportDiagnostic::ServerRequestAnswerWriteFailed {
        method: method.to_owned(),
        error: Box::new(error),
    }
    .report();
}

fn report_oversized_answer(method: CodexRoutedMethod, encoded_bytes: usize, limit: usize) {
    CodexTransportDiagnostic::ServerRequestAnswerOversized {
        method: method.method().to_owned(),
        encoded_bytes,
        limit,
    }
    .report();
}
