//! The status line under a running tool call: the provider's own words for its progress, live and
//! keyed per call, never stored.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::jsonrpc::streaming::SubscribeAcknowledgmentResponse;
use crate::method::methods;
use crate::provider::tool_call::ToolCallId;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::text::FreeFormText;

ts_constants! {
    /// The longest status line, in code points: the size of the longest one-line text a provider
    /// reports.
    pub const TOOL_CALL_STATUS_MAX_LEN: usize = 512;
}

/// The session whose tool calls' status lines an `agent.toolCall.status.subscribe` subscription
/// follows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentToolCallStatusSubscribeRequest {
    /// The session.
    pub session_id: SessionId,
}

/// One tool call's status line.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ToolCallStatusUpdate {
    /// The tool call.
    pub tool_call_id: ToolCallId,
    /// The call's newest status line, or `null` once the call closed, after which the key sends
    /// nothing more.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<FreeFormText<TOOL_CALL_STATUS_MAX_LEN>>")]
    pub status: Option<FreeFormText<TOOL_CALL_STATUS_MAX_LEN>>,
}

methods! {
    /// The status lines of a session's running tool calls.
    pub const TOOL_CALL_STATUS_METHOD_DESCRIPTORS = [
        /// Each running tool call's newest status line, one value per call.
        AgentToolCallStatusSubscribe = subscription "agent.toolCall.status.subscribe" {
            mutating: false,
            params: AgentToolCallStatusSubscribeRequest,
            result: SubscribeAcknowledgmentResponse,
            emission: ToolCallStatusUpdate,
            refusals: [SessionNotFound],
        },
    ];
}

/// The TypeScript module of the tool calls' status lines.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "tool-call-status",
    doc: "The status line under a running tool call: the provider's own words for its progress, \
          live and keyed per call, never stored.",
    definitions: &[
        Definition::read::<AgentToolCallStatusSubscribeRequest>(),
        Definition::read::<ToolCallStatusUpdate>(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&TOOL_CALL_STATUS_METHOD_DESCRIPTORS],
};
