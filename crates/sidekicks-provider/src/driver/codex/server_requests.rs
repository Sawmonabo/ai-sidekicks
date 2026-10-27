//! The requests the Codex service sends the daemon: which methods are routed to a person or the
//! callback-tool host, how each ask is classified and answered in its own method's shape, the
//! `-32601` every other method gets, and the turn a routed ask names.

use futures::future::BoxFuture;
use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Map, Value, json};
use sidekicks_contracts::jsonrpc::error_code::JsonRpcErrorCode;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::question::QuestionAnswer;
use sidekicks_contracts::run::id::RunId;
use sidekicks_std::text_cut::cut_to_code_points;

use crate::driver::codex::app_server_protocol::SERVER_REQUEST_METHODS;
use crate::driver::codex::delivery::question_answers::compose_codex_user_input_answers;
use crate::driver::codex::event_normalizer::is_codex_tool_call_approval_elicitation;
use crate::driver::contract::DriverError;
use crate::inbound_json::decode_inbound_json;
use crate::mcp::elicitation_form::compose_elicitation_content;

/// The refusal reason that stands in for an answer larger than the service takes, past which it
/// would close the socket: the answer is refused, never cut, since a cut tool output reads as
/// whole.
pub(crate) const CODEX_OUTBOUND_ANSWER_TOO_LARGE_REASON: &str = "The daemon composed an answer \
     larger than this transport will send; refusing rather than delivering a truncated result.";

/// The most code points of a turn id a routed ask names that the daemon resolves or records, the
/// same bound as a tool call's id, the same kind of opaque handle.
const CODEX_ROUTED_ASK_TURN_ID_MAX_CODE_POINTS: usize = 256;

/// Who answers a routed ask: the callback-tool host, the approvals, or the questions card.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CodexAskKind {
    /// A daemon tool's call, answered by the callback-tool host.
    CallbackTool,
    /// An approval, answered on the approvals card.
    Approval,
    /// A question, answered on the questions card.
    Question,
}

/// A server request the daemon routes, by its method. Every other method, `currentTime/read`,
/// `attestation/generate` and `account/chatgptAuthTokens/refresh` among them, is answered `-32601`
/// through [`compose_unrouted_request_error`]. A refusal answers `decline` or `denied`, never
/// `cancel` or `abort`, which would interrupt the turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CodexRoutedMethod {
    /// `item/tool/call`: a daemon tool's call.
    ToolCall,
    /// `item/commandExecution/requestApproval`.
    CommandExecutionApproval,
    /// `item/fileChange/requestApproval`.
    FileChangeApproval,
    /// `item/permissions/requestApproval`, which has no decline: its refusal is an empty grant.
    PermissionsApproval,
    /// `execCommandApproval`, the older command approval.
    ExecCommandApproval,
    /// `applyPatchApproval`, the older file-change approval.
    ApplyPatchApproval,
    /// `item/tool/requestUserInput`: a question, answered with its answers.
    UserInputRequest,
    /// `mcpServer/elicitation/request`: Codex's own approval of a tool-server call, or a tool
    /// server's question.
    ElicitationRequest,
}

/// Why a routed ask was never decided, so it answers its method's refusal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CodexUnadjudicatedAsk<'detail> {
    /// The daemon bound no responder.
    NoResponder,
    /// The responder failed; `detail` is its failure, bounded by the caller.
    ResponderFailed {
        /// The failure, in words.
        detail: &'detail str,
    },
}

impl CodexRoutedMethod {
    /// The routed method `method` names, or `None` for a method the daemon answers `-32601`.
    pub(crate) fn from_method(method: &str) -> Option<Self> {
        match method {
            "item/tool/call" => Some(Self::ToolCall),
            "item/commandExecution/requestApproval" => Some(Self::CommandExecutionApproval),
            "item/fileChange/requestApproval" => Some(Self::FileChangeApproval),
            "item/permissions/requestApproval" => Some(Self::PermissionsApproval),
            "execCommandApproval" => Some(Self::ExecCommandApproval),
            "applyPatchApproval" => Some(Self::ApplyPatchApproval),
            "item/tool/requestUserInput" => Some(Self::UserInputRequest),
            "mcpServer/elicitation/request" => Some(Self::ElicitationRequest),
            _ => None,
        }
    }

    /// The method as Codex's wire spells it.
    pub(crate) const fn method(self) -> &'static str {
        match self {
            Self::ToolCall => "item/tool/call",
            Self::CommandExecutionApproval => "item/commandExecution/requestApproval",
            Self::FileChangeApproval => "item/fileChange/requestApproval",
            Self::PermissionsApproval => "item/permissions/requestApproval",
            Self::ExecCommandApproval => "execCommandApproval",
            Self::ApplyPatchApproval => "applyPatchApproval",
            Self::UserInputRequest => "item/tool/requestUserInput",
            Self::ElicitationRequest => "mcpServer/elicitation/request",
        }
    }

    /// Who answers one ask of this method, from its untrusted `params`: an elicitation is an
    /// approval only when it is Codex's own approval of a tool-server call.
    pub(crate) fn classify_ask(self, params: &RawValue) -> CodexAskKind {
        match self {
            Self::ToolCall => CodexAskKind::CallbackTool,
            Self::CommandExecutionApproval
            | Self::FileChangeApproval
            | Self::PermissionsApproval
            | Self::ExecCommandApproval
            | Self::ApplyPatchApproval => CodexAskKind::Approval,
            Self::UserInputRequest => CodexAskKind::Question,
            Self::ElicitationRequest => {
                if is_codex_tool_call_approval_elicitation(params.get().as_bytes()) {
                    CodexAskKind::Approval
                } else {
                    CodexAskKind::Question
                }
            }
        }
    }

    /// The refusal this method's ask answers, carrying `reason` where the method has a place for
    /// one. A refusal never carries data: it grants nothing.
    pub(crate) fn compose_refused_result(self, reason: &str) -> Value {
        match self {
            Self::ToolCall => json!({
                "success": false,
                "contentItems": [{ "type": "inputText", "text": reason }],
            }),
            Self::CommandExecutionApproval | Self::FileChangeApproval => {
                json!({ "decision": "decline" })
            }
            Self::ElicitationRequest => json!({ "action": "decline" }),
            Self::PermissionsApproval => json!({ "permissions": {}, "scope": "turn" }),
            Self::ExecCommandApproval | Self::ApplyPatchApproval => {
                json!({ "decision": { "denied": { "rejection": reason } } })
            }
            // A question has no decline; an empty answer set is the refusal Codex reads.
            Self::UserInputRequest => json!({ "answers": {} }),
        }
    }

    /// The answer to an ask no responder decided: this method's own refusal, never `-32601`,
    /// which would be a protocol fault where a decision was asked, and never an allow.
    pub(crate) fn compose_unadjudicated_result(
        self,
        unadjudicated: CodexUnadjudicatedAsk<'_>,
    ) -> Value {
        match unadjudicated {
            CodexUnadjudicatedAsk::NoResponder => self.compose_refused_result(&format!(
                "The daemon has no responder registered for \"{}\"; refusing rather than \
                 answering without adjudication.",
                self.method()
            )),
            CodexUnadjudicatedAsk::ResponderFailed { detail } => {
                self.compose_refused_result(detail)
            }
        }
    }

    /// The result `answer` composes for one ask of this method, whose untrusted `params` the
    /// service sent. `None` when the answer does not fit the ask: an allow for a question, or
    /// answers for anything but a question, since answers sent for an approval would approve it;
    /// the caller refuses the ask instead.
    pub(crate) fn compose_answer_result(
        self,
        params: &RawValue,
        answer: &CodexServerRequestAnswer,
    ) -> Option<Value> {
        match answer {
            CodexServerRequestAnswer::Allow {
                is_for_session,
                payload,
            } => self.compose_allowed_result(payload.as_ref(), *is_for_session),
            CodexServerRequestAnswer::Refuse { reason } => {
                Some(self.compose_refused_result(reason))
            }
            CodexServerRequestAnswer::Answered { answers } => {
                self.compose_answered_result(params, answers)
            }
        }
    }

    // The allowed answer, kept for the rest of the conversation where `is_for_session`; `payload`
    // is the data the daemon supplies, merged beside the decision. A question takes no allow.
    fn compose_allowed_result(
        self,
        payload: Option<&Map<String, Value>>,
        is_for_session: bool,
    ) -> Option<Value> {
        match self {
            Self::ToolCall => {
                let content_items = payload
                    .and_then(|payload| payload.get("contentItems"))
                    .filter(|content_items| content_items.is_array())
                    .cloned()
                    .unwrap_or_else(|| json!([]));
                Some(json!({ "success": true, "contentItems": content_items }))
            }
            Self::CommandExecutionApproval | Self::FileChangeApproval => Some(json!({
                "decision": if is_for_session { "acceptForSession" } else { "accept" },
            })),
            // The granted profile is the daemon's to compose, so an allow with none grants
            // nothing rather than guessing a widening.
            Self::PermissionsApproval => {
                let permissions = payload
                    .and_then(|payload| payload.get("permissions"))
                    .filter(|permissions| permissions.is_object())
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                Some(json!({ "permissions": permissions, "scope": "turn" }))
            }
            Self::ExecCommandApproval | Self::ApplyPatchApproval => Some(json!({
                "decision": if is_for_session { "approved_for_session" } else { "approved" },
            })),
            Self::UserInputRequest => None,
            // A tool-server call allowed for the session says so in `_meta.persist`.
            Self::ElicitationRequest => {
                let mut result = Map::new();
                result.insert("action".to_owned(), json!("accept"));
                if let Some(content) = payload {
                    result.insert("content".to_owned(), Value::Object(content.clone()));
                }
                if is_for_session {
                    result.insert("_meta".to_owned(), json!({ "persist": "session" }));
                }
                Some(Value::Object(result))
            }
        }
    }

    // A question's answer from the questions card's answers, one per question in order; `None`
    // for an ask that is no question, or whose params do not read as JSON.
    fn compose_answered_result(
        self,
        params: &RawValue,
        answers: &[QuestionAnswer],
    ) -> Option<Value> {
        match self {
            Self::UserInputRequest => {
                let params = read_params_value(params)?;
                Some(json!({ "answers": compose_codex_user_input_answers(&params, answers) }))
            }
            Self::ElicitationRequest => {
                if self.classify_ask(params) != CodexAskKind::Question {
                    return None;
                }
                let params = read_params_value(params)?;
                Some(json!({
                    "action": "accept",
                    "content": compose_elicitation_content(&params, answers),
                }))
            }
            Self::ToolCall
            | Self::CommandExecutionApproval
            | Self::FileChangeApproval
            | Self::PermissionsApproval
            | Self::ExecCommandApproval
            | Self::ApplyPatchApproval => None,
        }
    }
}

// The ask's params as JSON for the composers that walk them; a held raw value is already JSON, so
// `None` is only a value nested past the reader's depth, which the caller refuses.
fn read_params_value(params: &RawValue) -> Option<Value> {
    serde_json::from_str(&decode_inbound_json(params.get().as_bytes())).ok()
}

/// The JSON-RPC error object answering a server request outside the routed table: `-32601`, which
/// no service reads as consent and which, unlike silence, never hangs the turn.
pub(crate) fn compose_unrouted_request_error() -> Value {
    json!({
        "code": JsonRpcErrorCode::MethodNotFound.code(),
        "message": "The daemon does not handle this server request.",
    })
}

/// Whether `method` is one of the server requests the service's protocol names, routed or not,
/// so a report of an unhandled one tells a known method from one a newer build added.
pub(crate) fn is_codex_server_request_method(method: &str) -> bool {
    SERVER_REQUEST_METHODS.contains(&method)
}

/// The daemon's answer to one routed ask.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CodexServerRequestAnswer {
    /// Allowed, kept for the rest of the conversation where `is_for_session`.
    Allow {
        /// Whether the allow holds for the rest of the conversation.
        is_for_session: bool,
        /// Data the daemon supplies, read by the methods whose answer carries it: a tool call's
        /// `contentItems`, a granted permission profile under `permissions`, or an elicitation's
        /// content.
        payload: Option<Map<String, Value>>,
    },
    /// Refused, with the reason the methods that carry one send.
    Refuse {
        /// Why, in words.
        reason: String,
    },
    /// A question answered with the questions card's answers, one per question in order.
    Answered {
        /// The answers.
        answers: Vec<QuestionAnswer>,
    },
}

/// What a responder did with one ask: answered it now, or held it for the person, who answers it
/// later by its request id; a held ask stays pending at the service until then.
pub(crate) enum CodexServerRequestDecision {
    /// Answered now.
    Answer(CodexServerRequestAnswer),
    /// Held for the person.
    Held {
        /// Runs once the connection holds the ask, so an answer the daemon reaches at once finds
        /// it held; a connection that closed first runs none.
        on_held: Option<Box<dyn FnOnce() + Send>>,
    },
}

/// One routed ask as the daemon's responder sees it.
#[derive(Debug)]
pub(crate) struct CodexInboundServerRequest {
    /// The service's own request id, as its JSON, unique on one connection; a held ask is
    /// answered under it.
    pub(crate) request_id: String,
    /// The routed method.
    pub(crate) method: CodexRoutedMethod,
    /// Who answers it.
    pub(crate) ask_kind: CodexAskKind,
    /// The ask's params as the service sent them, untrusted, `null` when it sent none.
    pub(crate) params: Box<RawValue>,
}

/// The port the daemon binds to answer routed asks. With none bound every routed ask answers its
/// own refusal.
pub(crate) trait CodexServerRequestResponder: Send + Sync {
    /// Answers or holds one ask; a failure leaves the ask undecided, so it is refused. Called on
    /// the connection's reader in arrival order, so whatever it does before it returns happens
    /// between the frames around the ask; the future it returns is awaited off the reader.
    fn answer(
        &self,
        request: CodexInboundServerRequest,
    ) -> BoxFuture<'static, Result<CodexServerRequestDecision, DriverError>>;
}

/// The turn a routed ask names. An over-long id is never resolved, since a cut prefix could match
/// a shorter live turn, but is recorded cut, since no id would read as an ask that named none.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CodexRoutedAskTurnId {
    /// The ask named no turn.
    Absent,
    /// The id as sent, usable for a route lookup.
    Resolvable(String),
    /// An id past the bound, cut to it for a record.
    Unresolvable {
        /// The id cut to the bound.
        recorded: String,
    },
}

// The one member of a routed ask's params the turn reading reads.
#[derive(Deserialize)]
struct RoutedAskParams {
    #[serde(rename = "turnId")]
    turn_id: Option<String>,
}

/// Reads the turn a routed ask's untrusted `params` name, bounded here since the text reaches a
/// refusal reason and a diagnostic. Params that are no object, or a `turnId` that is no text or
/// is empty, name no turn: the older approvals carry none and an elicitation's may be `null`.
pub(crate) fn read_routed_ask_turn_id(params: &RawValue) -> CodexRoutedAskTurnId {
    let Some(turn_id) =
        serde_json::from_str::<RoutedAskParams>(&decode_inbound_json(params.get().as_bytes()))
            .ok()
            .and_then(|params| params.turn_id)
            .filter(|turn_id| !turn_id.is_empty())
    else {
        return CodexRoutedAskTurnId::Absent;
    };
    let recorded = cut_to_code_points(&turn_id, CODEX_ROUTED_ASK_TURN_ID_MAX_CODE_POINTS);
    if recorded.len() < turn_id.len() {
        return CodexRoutedAskTurnId::Unresolvable {
            recorded: recorded.to_owned(),
        };
    }
    CodexRoutedAskTurnId::Resolvable(turn_id)
}

/// The refusal reason for one routed ask that cannot be attributed to a run, composed from the
/// bounded reading so a provider turn id cannot size it.
pub(crate) fn compose_routed_ask_refusal_reason(
    method: CodexRoutedMethod,
    turn_id: &CodexRoutedAskTurnId,
) -> String {
    let method = method.method();
    match turn_id {
        CodexRoutedAskTurnId::Absent => format!(
            "The provider's \"{method}\" request named no turn, and this method's params require \
             one, so the daemon cannot say which run raised it; refusing rather than attributing \
             it to a run that did not."
        ),
        CodexRoutedAskTurnId::Unresolvable { .. } => format!(
            "The provider's \"{method}\" request named a turn id past the length this daemon \
             reads, so it cannot be resolved to a run; refusing rather than matching a truncated \
             prefix against a live turn."
        ),
        CodexRoutedAskTurnId::Resolvable(turn_id) => format!(
            "The provider's \"{method}\" request named turn \"{turn_id}\", which this daemon \
             holds no live route for; refusing rather than attributing it to a run that did not \
             raise it."
        ),
    }
}

/// The run an ask belongs to and the binding its permission ask is delivered on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexAskOwner {
    /// The run.
    pub(crate) run_id: RunId,
    /// The binding the run's deliveries go on.
    pub(crate) binding_id: RuntimeBindingId,
}

/// How one routed ask was attributed to a run: by its helper's child run or its named turn, by
/// the session's sole active run when it named no usable turn, or refused when its named turn
/// cannot be resolved.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CodexRoutedAskAttribution {
    /// The ask's own child run or turn named its run.
    Attributed {
        /// The run and binding.
        owner: CodexAskOwner,
    },
    /// No usable turn was named; the session's sole active run, if one, takes it.
    Unattributed {
        /// The sole active run and its binding, or `None`.
        owner: Option<CodexAskOwner>,
    },
    /// The named turn cannot be resolved, so the ask is refused.
    Refused {
        /// The refusal reason.
        reason: String,
    },
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::value::RawValue;
    use serde_json::{Value, json};
    use sidekicks_contracts::jsonrpc::error_code::JsonRpcErrorCode;
    use sidekicks_contracts::question::QuestionAnswer;
    use sidekicks_contracts::wire::text::NonEmptyText;

    use super::{
        CodexRoutedAskTurnId, CodexRoutedMethod, CodexServerRequestAnswer, CodexUnadjudicatedAsk,
        compose_unrouted_request_error, read_routed_ask_turn_id,
    };

    fn raw(value: &Value) -> Box<RawValue> {
        RawValue::from_string(value.to_string()).expect("a JSON value is raw JSON")
    }

    // The result with its reason text blanked, so two refusals compare by what they grant.
    fn without_reason(result: &Value) -> Value {
        let mut grant = result.clone();
        for reason_member in ["/contentItems/0/text", "/decision/denied/rejection"] {
            if let Some(reason) = grant.pointer_mut(reason_member) {
                *reason = json!("");
            }
        }
        grant
    }

    // Every refusal grants nothing, and an ask no responder decided answers that same refusal.
    #[rstest]
    #[case::tool_call(
        "item/tool/call",
        json!({"success": false, "contentItems": [{"type": "inputText", "text": "Why."}]})
    )]
    #[case::command("item/commandExecution/requestApproval", json!({"decision": "decline"}))]
    #[case::file_change("item/fileChange/requestApproval", json!({"decision": "decline"}))]
    #[case::permissions(
        "item/permissions/requestApproval",
        json!({"permissions": {}, "scope": "turn"})
    )]
    #[case::exec_command(
        "execCommandApproval",
        json!({"decision": {"denied": {"rejection": "Why."}}})
    )]
    #[case::apply_patch(
        "applyPatchApproval",
        json!({"decision": {"denied": {"rejection": "Why."}}})
    )]
    #[case::user_input("item/tool/requestUserInput", json!({"answers": {}}))]
    #[case::elicitation("mcpServer/elicitation/request", json!({"action": "decline"}))]
    fn a_refused_or_undecided_ask_answers_its_own_refusal(
        #[case] method: &str,
        #[case] refusal: Value,
    ) {
        let routed = CodexRoutedMethod::from_method(method).expect("the method is routed");

        assert_eq!(routed.compose_refused_result("Why."), refusal);
        assert_eq!(
            routed.compose_unadjudicated_result(CodexUnadjudicatedAsk::ResponderFailed {
                detail: "Why."
            }),
            refusal
        );
        assert_eq!(
            without_reason(
                &routed.compose_unadjudicated_result(CodexUnadjudicatedAsk::NoResponder)
            ),
            without_reason(&refusal)
        );
    }

    #[rstest]
    #[case::current_time("currentTime/read")]
    #[case::auth_refresh("account/chatgptAuthTokens/refresh")]
    #[case::attestation("attestation/generate")]
    #[case::unknown("item/somethingNew/request")]
    fn a_method_outside_the_table_is_answered_method_not_found(#[case] method: &str) {
        assert_eq!(CodexRoutedMethod::from_method(method), None);
        assert_eq!(
            compose_unrouted_request_error()["code"],
            json!(JsonRpcErrorCode::MethodNotFound.code())
        );
    }

    #[test]
    fn an_answer_that_does_not_fit_its_ask_composes_nothing() {
        let answers = CodexServerRequestAnswer::Answered {
            answers: vec![QuestionAnswer::Typed {
                text: NonEmptyText::new("yes".to_owned()).expect("the text is not blank"),
            }],
        };
        let allow = CodexServerRequestAnswer::Allow {
            is_for_session: false,
            payload: None,
        };
        let tool_call_approval =
            raw(&json!({"_meta": {"codex_approval_kind": "mcp_tool_call"}, "message": "Run?"}));
        let no_params = raw(&json!({}));

        assert_eq!(
            CodexRoutedMethod::CommandExecutionApproval.compose_answer_result(&no_params, &answers),
            None
        );
        assert_eq!(
            CodexRoutedMethod::ElicitationRequest
                .compose_answer_result(&tool_call_approval, &answers),
            None
        );
        assert_eq!(
            CodexRoutedMethod::UserInputRequest.compose_answer_result(&no_params, &allow),
            None
        );
        assert_eq!(
            CodexRoutedMethod::UserInputRequest
                .compose_answer_result(&raw(&json!({"questions": [{"id": "q"}]})), &answers),
            Some(json!({"answers": {"q": {"answers": ["yes"]}}}))
        );
    }

    #[test]
    fn a_turn_id_past_256_code_points_is_never_resolvable() {
        let at_bound = "é".repeat(256);
        let past_bound = "é".repeat(257);

        assert_eq!(
            read_routed_ask_turn_id(&raw(&json!({"turnId": at_bound}))),
            CodexRoutedAskTurnId::Resolvable(at_bound.clone())
        );
        assert_eq!(
            read_routed_ask_turn_id(&raw(&json!({"turnId": past_bound}))),
            CodexRoutedAskTurnId::Unresolvable { recorded: at_bound }
        );
        assert_eq!(
            read_routed_ask_turn_id(&raw(&json!({"turnId": 7}))),
            CodexRoutedAskTurnId::Absent
        );
        assert_eq!(
            read_routed_ask_turn_id(&raw(&json!({"turnId": ""}))),
            CodexRoutedAskTurnId::Absent
        );
    }
}
