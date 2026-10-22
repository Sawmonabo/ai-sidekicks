//! The payloads of the `approval.*` events the daemon records: one per event type, and the
//! session's own remembered answers rebuild from them alone.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::agent::definition::AgentId;
use crate::approval::{
    ApprovalCategory, ApprovalRequestId, ApprovalScope, InvalidationTrigger, RememberedRuleId,
    RememberedScope, ReviewerDenialId,
};
use crate::event::version::EVENT_FIELD_MAX_LEN;
use crate::machine::id::MachineId;
use crate::run::id::RunId;
use crate::session::id::SessionId;
use crate::trust_statement::DeviceId;
use crate::wire::id::ClientUuid;
use crate::wire::record::JsonRecord;
use crate::wire::text::{FreeFormText, NonEmptyText};

/// The `approval.requested` payload. `askId` is present when the request is a provider's
/// permission ask: the daemon's own durable id for the ask, so an answer reaches the right ask
/// after a restart when several are open on one run. `toolCallId` names the tool call the ask
/// holds, so that call's row draws its held mark and `Declined`. The ask's tool name and the
/// provider's prompt text ride `resourceDescriptor`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalRequestedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The run.
    pub run_id: RunId,
    /// The ask.
    pub approval_request_id: ApprovalRequestId,
    /// What it is about.
    pub category: ApprovalCategory,
    /// Its target scope.
    pub scope: ApprovalScope,
    /// Who asked.
    pub requested_by: NonEmptyText,
    /// What it would touch.
    pub resource_descriptor: JsonRecord,
    /// The daemon's durable id for a provider's permission ask.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "NonEmptyText")]
    pub ask_id: Option<NonEmptyText>,
    /// The tool call the ask holds, bounded as the tool rows bound it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<EVENT_FIELD_MAX_LEN>")]
    pub tool_call_id: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
}

/// The `approval.approved` and `approval.rejected` payload: the answer, the device it came from,
/// the id the answering client minted, on an approval the command or path as the person corrected
/// it, and on a decline the words the person gave.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalResolvedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The run.
    pub run_id: RunId,
    /// The ask.
    pub approval_request_id: ApprovalRequestId,
    /// What it is about.
    pub category: ApprovalCategory,
    /// Its target scope.
    pub scope: ApprovalScope,
    /// The recorded scope.
    pub effective_scope: ApprovalScope,
    /// The device that answered.
    pub device_id: DeviceId,
    /// The id the answering client minted.
    pub client_resolution_id: ClientUuid,
    /// The rule the person asked to keep with the answer, so a rebuild and a resend record the
    /// rule asked for even when its own event was never written.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "RememberedScope")]
    pub remembered_scope: Option<RememberedScope>,
    /// The `why not` words, which go back to the agent; only on `approval.rejected`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "NonEmptyText")]
    pub decline_reason: Option<NonEmptyText>,
    /// The corrected command or path, which is what runs; only on `approval.approved`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "NonEmptyText")]
    pub edited_action: Option<NonEmptyText>,
}

/// The `approval.canceled` payload: the ask ended with its run and can no longer be answered.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalCanceledPayload {
    /// The session.
    pub session_id: SessionId,
    /// The run.
    pub run_id: RunId,
    /// The ask.
    pub approval_request_id: ApprovalRequestId,
    /// What it was about.
    pub category: ApprovalCategory,
    /// Its target scope.
    pub scope: ApprovalScope,
}

/// The `approval.rule.remembered` payload: the whole rule, so it rebuilds from the log.
/// `machineId` is the machine whose provider keeps it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalRuleRememberedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The run.
    pub run_id: RunId,
    /// The ask.
    pub approval_request_id: ApprovalRequestId,
    /// What it is about.
    pub category: ApprovalCategory,
    /// Its target scope.
    pub scope: ApprovalScope,
    /// The machine whose provider keeps the rule.
    pub machine_id: MachineId,
    /// The rule.
    pub rule_id: RememberedRuleId,
    /// Its reach, subject and sense.
    pub remembered_scope: RememberedScope,
}

/// The `approval.rule.revoked` payload. The run and the ask are absent where no ask was in flight,
/// as when a project is detached or a tool server is removed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalRuleRevokedPayload {
    /// The session.
    pub session_id: SessionId,
    /// What it was about.
    pub category: ApprovalCategory,
    /// Its target scope.
    pub scope: ApprovalScope,
    /// The rule.
    pub rule_id: RememberedRuleId,
    /// Why it ended.
    pub invalidation_trigger: InvalidationTrigger,
    /// The run, where an ask was in flight.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "RunId")]
    pub run_id: Option<RunId>,
    /// The ask, where one was in flight.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ApprovalRequestId")]
    pub approval_request_id: Option<ApprovalRequestId>,
}

/// The `approval.reviewer.denied` payload: a provider's own reviewer blocked an action. The daemon
/// keeps the denial whole beside the row, which is what lets the override hold across a restart.
/// `eventId` names the blocked call's own row, whose reason line reads `Blocked · <reason>`, or
/// `Blocked` alone where the reviewer gave no reason; a block that names no call, such as a review
/// of a network request, has none and is a row of its own. `overridable` is false where the
/// provider lets no person overrule the block, and no `Allow once` is drawn.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalReviewerDeniedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The run.
    pub run_id: RunId,
    /// The agent whose action was blocked.
    pub agent_id: AgentId,
    /// The block.
    pub denial_id: ReviewerDenialId,
    /// The blocked call's own row; absent on a block that names no call.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "NonEmptyText")]
    pub event_id: Option<NonEmptyText>,
    /// The reviewer's reason.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "NonEmptyText")]
    pub reason: Option<NonEmptyText>,
    /// Whether a person may overrule it.
    pub overridable: bool,
}

/// The `approval.denial.overridden` payload: the person allowed a blocked action once.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalDenialOverriddenPayload {
    /// The session.
    pub session_id: SessionId,
    /// The block.
    pub denial_id: ReviewerDenialId,
}
