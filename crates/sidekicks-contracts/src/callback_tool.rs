//! The daemon's callback tools as the allowlist picker reads them. The catalog is the machine's
//! own (the editor has no session) and fixed: names come from the daemon's own registrations,
//! never from provider output.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::provider::driver::length_limits::{
    DRIVER_TOOL_DESCRIPTION_MAX_LEN, DRIVER_TOOL_NAME_MAX_LEN,
};
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire;
use crate::wire::text::{BoundedText, FreeFormText};

/// One callback tool. `name` is the name a provider sees; `label` is the words a person reads, the
/// one label the picker and the transcript both draw, and a tool without one is drawn as its name
/// in sentence case.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CallbackToolEntry {
    /// The name a provider sees.
    pub name: FreeFormText<DRIVER_TOOL_NAME_MAX_LEN>,
    /// The words a person reads.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "wire::present"
    )]
    #[schemars(with = "FreeFormText<DRIVER_TOOL_NAME_MAX_LEN>")]
    pub label: Option<FreeFormText<DRIVER_TOOL_NAME_MAX_LEN>>,
    /// What the tool does.
    pub description: BoundedText<0, DRIVER_TOOL_DESCRIPTION_MAX_LEN>,
}

/// The daemon's callback tools.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentCallbackToolListResponse {
    /// The tools.
    pub tools: Vec<CallbackToolEntry>,
}

methods! {
    /// The `agent.callbackTool.*` methods.
    pub const CALLBACK_TOOL_METHOD_DESCRIPTORS = [
        /// Lists the daemon's callback tools for the allowlist picker.
        AgentCallbackToolList = query "agent.callbackTool.list" {
            mutating: false,
            params: EmptyPayload,
            result: AgentCallbackToolListResponse,
            refusals: [],
        },
    ];
}

/// The TypeScript module of the callback tools.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "callback-tool",
    doc: "The daemon's callback tools as the allowlist picker reads them.",
    definitions: &[
        Definition::read::<CallbackToolEntry>(),
        Definition::read::<AgentCallbackToolListResponse>(),
    ],
    constants: &[],
    method_tables: &[&CALLBACK_TOOL_METHOD_DESCRIPTORS],
};
