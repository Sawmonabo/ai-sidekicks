//! A session's live agents as a client reads and moves them: the live agent list, the switch of a
//! running agent's binding, and the `agent.*` method table, which also carries the definition
//! verbs. An agent is in its session or it is not: it has no lifecycle state.

use schemars::{JsonSchema, Schema};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent::definition::binding::{AgentProviderBinding, ProviderToken};
use crate::agent::definition::requests::{
    AgentDefinitionCreateRequest, AgentDefinitionCreateResponse, AgentDefinitionDeleteRequest,
    AgentDefinitionDeleteResponse, AgentDefinitionExportRequest, AgentDefinitionExportResponse,
    AgentDefinitionImportRequest, AgentDefinitionImportResponse, AgentDefinitionListRequest,
    AgentDefinitionListResponse, AgentDefinitionUpdateRequest, AgentDefinitionUpdateResponse,
};
use crate::agent::definition::{AgentId, AgentResolvedConfiguration, ToolName, required_member};
use crate::agent::provider_binding::{
    AgentBindingSwitchDisposition, AgentBindingSwitchPending, add_model_move_window_rule,
    model_move_names_window,
};
use crate::agent::tree::AgentTreeMember;
use crate::jsonrpc::streaming::{SubscribeAckResponse, SubscriptionId};
use crate::method::methods;
use crate::provider::driver::output_speed::ProviderOutputSpeedState;
use crate::provider::name::ProviderName;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;

/// The session whose agents `agent.list` streams.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentListRequest {
    /// The session.
    pub session_id: SessionId,
}

/// One agent in the session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentListEntry {
    /// The agent.
    pub agent_id: AgentId,
    /// Its name.
    pub name: ToolName,
    /// The binding it runs under now, never the pending one.
    pub binding: AgentProviderBinding,
    /// The speed the provider declared on the live binding; absent until it declares one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProviderOutputSpeedState")]
    pub observed_output_speed: Option<ProviderOutputSpeedState>,
    /// Present exactly while a switch waits, so every client learns of it, after a restart too.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "AgentBindingSwitchPending")]
    #[garde(dive)]
    pub pending_switch: Option<AgentBindingSwitchPending>,
    /// Present exactly when the agent started from a saved definition, which names it on screen.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "AgentResolvedConfiguration")]
    pub resolved_configuration: Option<AgentResolvedConfiguration>,
    /// From the lead down to this agent's parent; empty for the lead.
    pub ancestry: Vec<AgentTreeMember>,
    /// When it joined the session.
    #[garde(dive)]
    pub created_at: WireInstant,
}

/// `agent.list`'s acknowledgment: the subscription and the session's agents as they stand. Every
/// later emission is one [`AgentListEntry`] as it changes, so a switch in flight and its
/// settlement reach every window and device.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentListAck {
    /// The subscription.
    pub subscription_id: SubscriptionId,
    /// The session's agents.
    #[garde(dive)]
    pub agents: Vec<AgentListEntry>,
}

/// Moves a running agent's model, window, effort, speed or provider: an omitted member is
/// unchanged and at least one moves, settled by the binding events. A provider switch applies at
/// the end of the run in flight; the account is no member, since it follows the provider's
/// current account. A model move names its window.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[garde(custom(update_moves_a_member))]
#[schemars(transform = add_moves_a_member_rule, transform = add_model_move_window_rule)]
pub struct AgentConfigUpdateRequest {
    /// The agent.
    pub agent_id: AgentId,
    /// The provider.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProviderName")]
    pub driver_name: Option<ProviderName>,
    /// The model.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProviderToken")]
    pub model_id: Option<ProviderToken>,
    /// The effort.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProviderToken")]
    pub effort: Option<ProviderToken>,
    /// The speed.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProviderToken")]
    pub output_speed: Option<ProviderToken>,
    /// The window in tokens, or `null` back to the model's default.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "serde_with::rust::double_option"
    )]
    #[schemars(with = "crate::wire::NullableSchema<SafeInt<1>>")]
    pub larger_window: Option<Option<SafeInt<1>>>,
    /// Interrupt the run first and hold the request open until the switch settles.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "bool")]
    pub interrupt_and_switch: Option<bool>,
}

/// Whether an update moves at least one member, and names its window on a model move.
fn update_moves_a_member(request: &AgentConfigUpdateRequest, _: &()) -> garde::Result {
    let moves_a_member = request.driver_name.is_some()
        || request.model_id.is_some()
        || request.effort.is_some()
        || request.output_speed.is_some()
        || request.larger_window.is_some();
    if !moves_a_member {
        return Err(garde::Error::new(
            "an update moves at least one of driverName, modelId, largerWindow, effort or \
             outputSpeed",
        ));
    }
    model_move_names_window(request.model_id.as_ref(), request.larger_window.as_ref())
}

/// The schema twin of the first half of [`update_moves_a_member`].
fn add_moves_a_member_rule(schema: &mut Schema) {
    let moves = [
        "driverName",
        "modelId",
        "effort",
        "outputSpeed",
        "largerWindow",
    ]
    .map(required_member)
    .to_vec();
    schema.insert("anyOf".into(), Value::Array(moves));
}

/// The switch the update became, and when the agent row recorded it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentConfigUpdateResponse {
    /// The agent.
    pub agent_id: AgentId,
    /// When the row recorded it.
    #[garde(dive)]
    pub updated_at: WireInstant,
    /// The switch.
    #[garde(dive)]
    pub switch: AgentBindingSwitchDisposition,
}

methods! {
    /// Every `agent.*` method. `agent.definitionSubscribe` resends the whole
    /// `agent.definitionList` reply on each change to the registry.
    pub const AGENT_METHOD_DESCRIPTORS = [
        /// Streams the session's agents.
        AgentList = subscription "agent.list" {
            mutating: false,
            params: AgentListRequest,
            result: AgentListAck,
            emission: AgentListEntry,
            refusals: [SessionNotFound],
        },
        /// Moves a running agent's binding.
        AgentConfigUpdate = mutation "agent.configUpdate" {
            mutating: true,
            params: AgentConfigUpdateRequest,
            result: AgentConfigUpdateResponse,
            refusals: [AgentNotFound, AgentProviderAxisInvalid, DriverCapabilityUnsupported],
        },
        /// Reads the definition registry.
        AgentDefinitionList = query "agent.definitionList" {
            mutating: false,
            params: AgentDefinitionListRequest,
            result: AgentDefinitionListResponse,
            refusals: [AgentDefinitionUnreadable],
        },
        /// Streams the definition registry.
        AgentDefinitionSubscribe = subscription "agent.definitionSubscribe" {
            mutating: false,
            params: AgentDefinitionListRequest,
            result: SubscribeAckResponse,
            emission: AgentDefinitionListResponse,
            refusals: [AgentDefinitionUnreadable],
        },
        /// Creates a definition.
        AgentDefinitionCreate = mutation "agent.definitionCreate" {
            mutating: true,
            params: AgentDefinitionCreateRequest,
            result: AgentDefinitionCreateResponse,
            refusals: [AgentDefinitionNameConflict],
        },
        /// Patches a definition.
        AgentDefinitionUpdate = mutation "agent.definitionUpdate" {
            mutating: true,
            params: AgentDefinitionUpdateRequest,
            result: AgentDefinitionUpdateResponse,
            refusals: [AgentDefinitionNotFound, AgentDefinitionNameConflict, AgentUpdateRefused],
        },
        /// Deletes a definition.
        AgentDefinitionDelete = mutation "agent.definitionDelete" {
            mutating: true,
            params: AgentDefinitionDeleteRequest,
            result: AgentDefinitionDeleteResponse,
            refusals: [AgentDefinitionNotFound],
        },
        /// Writes definitions into a folder.
        AgentDefinitionExport = mutation "agent.definitionExport" {
            mutating: true,
            params: AgentDefinitionExportRequest,
            result: AgentDefinitionExportResponse,
            refusals: [AgentDefinitionNotFound, AgentExportWriteFailed],
        },
        /// Creates the definitions a folder holds.
        AgentDefinitionImport = mutation "agent.definitionImport" {
            mutating: true,
            params: AgentDefinitionImportRequest,
            result: AgentDefinitionImportResponse,
            refusals: [],
        },
    ];
}

/// The TypeScript module of the live agents.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "agent/methods",
    doc: "A session's live agents as a client reads and moves them, and the `agent.*` method \
          table, which also carries the definition verbs.",
    definitions: &[
        Definition::read::<AgentListRequest>(),
        Definition::read::<AgentListEntry>().checked(),
        Definition::read::<AgentListAck>(),
        Definition::read::<AgentConfigUpdateRequest>(),
        Definition::read::<AgentConfigUpdateResponse>(),
    ],
    constants: &[],
    method_tables: &[&AGENT_METHOD_DESCRIPTORS],
};
