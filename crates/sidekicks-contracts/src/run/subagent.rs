//! The payload of a provider's own subagent starting and finishing under a run.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::event::envelope::{
    SourceEpoch, SourcePosition, check_epoch_stamp, epoch_stamp_dependent_required,
};
use crate::provider::driver::methods::PROVIDER_WIRE_HANDLE_MAX_LEN;
use crate::provider::id::ProviderId;
use crate::provider::tool_call::ToolCallId;
use crate::run::id::RunId;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::text::FreeFormText;

/// The `agent.subagent.started` and `agent.subagent.completed` payload: a helper the provider
/// started under the run `run_id`, by the provider's own id, and the tool call it was opened under
/// where the provider names one. `subagent_id` is unique only within its provider's run, so a
/// completion pairs to its start on `run_id`, `provider` and `subagent_id` together. It takes the
/// epoch stamp: `source_epoch` and `source_position` come together.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[schemars(extend("dependentRequired" = epoch_stamp_dependent_required()))]
pub struct SubagentLifecyclePayload {
    /// The session.
    pub session_id: SessionId,
    /// The run the helper runs under.
    pub run_id: RunId,
    /// The provider.
    pub provider: ProviderId,
    /// The provider's own id for the helper.
    pub subagent_id: FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>,
    /// The tool call the helper was opened under, where the provider names one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ToolCallId")]
    pub parent_tool_call_id: Option<ToolCallId>,
    /// The execution epoch a late row is attributed to; comes with `source_position`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SourceEpoch")]
    #[garde(custom(|epoch: &Option<SourceEpoch>, (): &()| {
        check_epoch_stamp(*epoch, self.source_position, true)
    }))]
    pub source_epoch: Option<SourceEpoch>,
    /// The turn position the row occupies within its epoch; comes with `source_epoch`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SourcePosition")]
    pub source_position: Option<SourcePosition>,
}

/// The TypeScript module of a provider's own subagent's lifecycle.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "run/subagent",
    doc: "The payload of a provider's own subagent starting and finishing under a run.",
    definitions: &[Definition::read::<SubagentLifecyclePayload>().checked()],
    constants: &[],
    method_tables: &[],
};
