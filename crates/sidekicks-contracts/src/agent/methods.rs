//! A session's live agents as a client reads and moves them: the live agent list, the switch of a
//! running agent's binding, and the live agents' method table, which also carries the definition
//! verbs. An agent is in its session or it is not: it has no lifecycle state.

use schemars::{JsonSchema, Schema};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent::definition::binding::ProviderToken;
use crate::agent::definition::requests::{
    AgentDefinitionCreateRequest, AgentDefinitionCreateResponse, AgentDefinitionDeleteRequest,
    AgentDefinitionDeleteResponse, AgentDefinitionExportRequest, AgentDefinitionExportResponse,
    AgentDefinitionImportRequest, AgentDefinitionImportResponse, AgentDefinitionListResponse,
    AgentDefinitionUpdateRequest, AgentDefinitionUpdateResponse,
};
use crate::agent::definition::{AgentId, AgentResolvedConfiguration};
use crate::agent::provider_binding::{
    AgentBindingSwitchDisposition, add_model_move_window_rule, model_move_names_window,
};
use crate::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, SubscriptionId};
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::provider::declaration::ProviderOptionSettings;
use crate::provider::id::ProviderId;
use crate::schema::required_member;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;

/// The session whose agents `agent.subscribe` streams.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentSubscribeRequest {
    /// The session.
    pub session_id: SessionId,
}

/// Declares a live agent's shape: the members every description of one carries, with its own
/// `resolvedConfiguration` member between the pending switch and the ancestry.
macro_rules! agent_entry {
    ($(#[doc = $doc:literal])+ $name:ident { $($resolved_configuration:tt)* }) => {
        $(#[doc = $doc])+
        #[derive(
            Clone,
            Debug,
            PartialEq,
            Eq,
            serde::Serialize,
            serde::Deserialize,
            schemars::JsonSchema,
            garde::Validate,
        )]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[garde(allow_unvalidated)]
        pub struct $name {
            /// The agent.
            pub agent_id: $crate::agent::definition::AgentId,
            /// Its name.
            pub name: $crate::agent::definition::ToolName,
            /// The binding it runs under now, never the pending one.
            pub binding: $crate::agent::definition::binding::AgentProviderBinding,
            /// The speed the provider declared on the live binding; absent until it declares one.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "crate::provider::driver::output_speed::ProviderOutputSpeedState")]
            pub observed_output_speed:
                Option<$crate::provider::driver::output_speed::ProviderOutputSpeedState>,
            /// The session options as the provider reports them on the live binding; absent where
            /// no binding is live or its driver declares none, never read as off.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "crate::provider::declaration::ObservedProviderOptions")]
            #[garde(dive)]
            pub observed_options: Option<$crate::provider::declaration::ObservedProviderOptions>,
            /// Present exactly while a switch waits, so every client learns of it, after a
            /// restart too.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "crate::agent::provider_binding::AgentBindingSwitchPending")]
            #[garde(dive)]
            pub pending_switch: Option<$crate::agent::provider_binding::AgentBindingSwitchPending>,
            $($resolved_configuration)*
            /// From the lead down to this agent's parent; empty for the lead.
            pub ancestry: Vec<$crate::agent::tree::AgentTreeMember>,
            /// When it joined the session.
            #[garde(dive)]
            pub created_at: $crate::wire::instant::WireInstant,
        }
    };
}

pub(crate) use agent_entry;

agent_entry! {
    /// One agent in the session.
    AgentSubscribeEntry {
        /// Present exactly when the agent started from a saved definition, which names it on
        /// screen.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "AgentResolvedConfiguration")]
        pub resolved_configuration: Option<AgentResolvedConfiguration>,
    }
}

/// `agent.subscribe`'s acknowledgment: the subscription and the session's agents as they stand.
/// Every later emission is one [`AgentSubscribeEntry`] as it changes, so a switch in flight and its
/// settlement reach every window and device.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentSubscribeResponse {
    /// The subscription.
    pub subscription_id: SubscriptionId,
    /// The session's agents.
    #[garde(dive)]
    pub agents: Vec<AgentSubscribeEntry>,
}

/// Moves a running agent's model, window, effort, speed, session options or provider: an omitted
/// member is unchanged and at least one moves, settled by the binding events. A provider switch
/// applies at the end of the run in flight; the account is no member, since it follows the
/// provider's current account. A model move names its window.
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
    #[schemars(with = "ProviderId")]
    pub driver_name: Option<ProviderId>,
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
    /// Values of the session options the target driver declares; an option left out keeps its
    /// value. The daemon checks each against the driver's declaration: an option the driver does
    /// not declare, or a value outside its declaration, is refused `agent.providerAxisInvalid`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProviderOptionSettings")]
    #[garde(dive)]
    pub options: Option<ProviderOptionSettings>,
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
#[expect(
    clippy::trivially_copy_pass_by_ref,
    reason = "garde passes a check's context by reference"
)]
fn update_moves_a_member(request: &AgentConfigUpdateRequest, (): &()) -> garde::Result {
    let moves_a_member = request.driver_name.is_some()
        || request.model_id.is_some()
        || request.effort.is_some()
        || request.output_speed.is_some()
        || request.options.is_some()
        || request.larger_window.is_some();
    if !moves_a_member {
        return Err(garde::Error::new(
            "an update moves at least one of driverName, modelId, largerWindow, effort, \
             outputSpeed or options",
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
        "options",
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
    /// The live agents' methods and the definition verbs. `agent.definition.subscribe` resends
    /// the whole `agent.definition.list` reply on each change to the registry.
    pub const AGENT_METHOD_DESCRIPTORS = [
        /// Streams the session's agents.
        AgentSubscribe = subscription "agent.subscribe" {
            mutating: false,
            params: AgentSubscribeRequest,
            result: AgentSubscribeResponse,
            emission: AgentSubscribeEntry,
            refusals: [SessionNotFound],
        },
        /// Moves a running agent's binding.
        AgentConfigUpdate = mutation "agent.config.update" {
            mutating: true,
            params: AgentConfigUpdateRequest,
            result: AgentConfigUpdateResponse,
            refusals: [
                AgentNotFound,
                AgentProviderAxisInvalid,
                ProviderNotFound,
                ProviderCapabilityUnsupported,
            ],
        },
        /// Reads the definition registry.
        AgentDefinitionList = query "agent.definition.list" {
            mutating: false,
            params: EmptyPayload,
            result: AgentDefinitionListResponse,
            refusals: [AgentDefinitionUnreadable],
        },
        /// Streams the definition registry.
        AgentDefinitionSubscribe = subscription "agent.definition.subscribe" {
            mutating: false,
            params: EmptyPayload,
            result: SubscribeAcknowledgmentResponse,
            emission: AgentDefinitionListResponse,
            refusals: [AgentDefinitionUnreadable],
        },
        /// Creates a definition.
        AgentDefinitionCreate = mutation "agent.definition.create" {
            mutating: true,
            params: AgentDefinitionCreateRequest,
            result: AgentDefinitionCreateResponse,
            refusals: [AgentDefinitionNameConflict, ProjectNotFound],
        },
        /// Patches a definition.
        AgentDefinitionUpdate = mutation "agent.definition.update" {
            mutating: true,
            params: AgentDefinitionUpdateRequest,
            result: AgentDefinitionUpdateResponse,
            refusals: [
                AgentDefinitionNotFound,
                AgentDefinitionNameConflict,
                AgentDefinitionUpdateRefused,
            ],
        },
        /// Deletes a definition.
        AgentDefinitionDelete = mutation "agent.definition.delete" {
            mutating: true,
            params: AgentDefinitionDeleteRequest,
            result: AgentDefinitionDeleteResponse,
            refusals: [AgentDefinitionNotFound],
        },
        /// Writes definitions into a folder.
        AgentDefinitionExport = mutation "agent.definition.export" {
            mutating: true,
            params: AgentDefinitionExportRequest,
            result: AgentDefinitionExportResponse,
            refusals: [AgentDefinitionNotFound, AgentDefinitionExportWriteFailed],
        },
        /// Creates the definitions a folder holds.
        AgentDefinitionImport = mutation "agent.definition.import" {
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
    doc: "A session's live agents as a client reads and moves them, and the live agents' method \
          table, which also carries the definition verbs.",
    definitions: &[
        Definition::read::<AgentSubscribeRequest>(),
        Definition::read::<AgentSubscribeEntry>().checked(),
        Definition::read::<AgentSubscribeResponse>(),
        Definition::read::<AgentConfigUpdateRequest>(),
        Definition::read::<AgentConfigUpdateResponse>(),
    ],
    constants: &[],
    method_tables: &[&AGENT_METHOD_DESCRIPTORS],
};
