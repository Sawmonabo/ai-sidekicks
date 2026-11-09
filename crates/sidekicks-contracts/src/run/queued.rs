//! The `agent.run.queued` payload: a run's creation, and the one durable record of how it came to
//! be.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::{IntoStaticStr, VariantArray};

use crate::agent::definition::binding::ProviderToken;
use crate::agent::definition::{AgentId, AgentResolvedConfiguration};
use crate::agent::methods::agent_entry;
use crate::agent::tree::ChildHandle;
use crate::orchestration::OrchestrationRunConfig;
use crate::provider::account::record::ProviderAccountId;
use crate::provider::driver::methods::PROVIDER_WIRE_HANDLE_MAX_LEN;
use crate::provider::id::ProviderId;
use crate::provider::tool_call::ToolCallId;
use crate::run::id::RunId;
use crate::run::queue::MessageContent;
use crate::run::subagent::SubagentId;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::integer::SafeInt;
use crate::wire::text::FreeFormText;
use crate::wire::{Never, literal};

/// How a child run was reached: a provider's own subagent, a run another agent asked for through
/// the bridge, or a workflow step. Internal to the agent index; the screen never shows it.
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    Hash,
    Serialize,
    Deserialize,
    JsonSchema,
    IntoStaticStr,
    VariantArray,
)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum ChildRunProvenance {
    /// A provider's own subagent.
    ProviderSubagent,
    /// A run another agent asked for through the bridge.
    BridgeRun,
    /// A workflow step.
    WorkflowStep,
}

literal! {
    /// The state a run is created in, which `agent.run.queued` enters.
    pub enum AgentRunQueuedNewState = "queued";
}

agent_entry! {
    /// An agent minted from a saved definition with the run that creates it: the one shape
    /// `agent.subscribe` describes an agent in, with the configuration it was resolved from always
    /// named.
    ResolvedAgent {
        /// The configuration it was resolved from, whose definition it names.
        pub resolved_configuration: AgentResolvedConfiguration,
    }
}

/// A provider's own helper as the run it starts names it: the handle the daemon minted for it, the
/// ids its provider gave it and its parent, the ask it was started with, and the model and effort
/// the start names.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderChildStart {
    /// The handle the daemon minted for the helper at its first start.
    pub child_handle: ChildHandle,
    /// The provider that started the helper.
    pub provider: ProviderId,
    /// The provider's own id for the helper.
    pub subagent_id: SubagentId,
    /// The provider's id for the helper it runs under; absent under the lead.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SubagentId")]
    pub parent_subagent_id: Option<SubagentId>,
    /// The handle of the helper it runs under; absent under the lead or where no node holds it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ChildHandle")]
    pub parent_child_handle: Option<ChildHandle>,
    /// The name its provider gave it, where the provider names helpers.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>")]
    pub name: Option<FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>>,
    /// The role its provider started it in.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>")]
    pub role: Option<FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>>,
    /// Its path in its provider's tree, where the provider keeps one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>")]
    pub provider_path: Option<FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>>,
    /// The ask its provider started it with, whole, where the start names one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "MessageContent")]
    pub ask: Option<MessageContent>,
    /// The model its provider started it on, where the start names one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProviderToken")]
    pub model_id: Option<ProviderToken>,
    /// The reasoning effort its provider started it at, in the provider's own word, where the start
    /// names one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProviderToken")]
    pub effort: Option<ProviderToken>,
    /// The provider's call that started this run of the helper, where the provider names one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ToolCallId")]
    pub start_call_id: Option<ToolCallId>,
}

/// Declares one arm of [`AgentRunQueuedPayload`] with the members every arm repeats.
macro_rules! run_queued_payload {
    ($(#[doc = $doc:literal])+ $name:ident { $($agent:tt)* }) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[schemars(inline)]
        #[garde(allow_unvalidated)]
        pub struct $name {
            /// The session.
            pub session_id: SessionId,
            /// The run.
            pub run_id: RunId,
            /// The run's version at creation.
            pub run_version: SafeInt<0>,
            /// Always `queued`.
            pub new_state: AgentRunQueuedNewState,
            $($agent)*
            /// The run this one is a child of.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "RunId")]
            pub parent_run_id: Option<RunId>,
            /// How the child was reached; present with `parent_run_id`.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "ChildRunProvenance")]
            pub reached_by: Option<ChildRunProvenance>,
            /// The limits admission resolved, the request's own else the session's default, so a
            /// rebuild restores them even if the defaults change mid-run.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "OrchestrationRunConfig")]
            pub effective_run_config: Option<OrchestrationRunConfig>,
            /// The model family as of admission, which derived pricing keys off.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>")]
            pub admitted_model_family: Option<FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>>,
            /// The account the run was admitted against, resolved before its provider is called.
            pub admitted_provider_account_id: ProviderAccountId,
        }
    };
}

run_queued_payload! {
    /// A run created for an agent already in the session; the lead's run names the session's lead
    /// this way.
    RunQueuedSessionAgentPayload {
        /// The agent.
        pub agent_id: AgentId,
        /// Only a run for an agent resolved from a definition carries it.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub resolved_agent: Option<Never>,
        /// The provider's own helper the run is for; present only on a run reached as
        /// `providerSubagent`.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "ProviderChildStart")]
        pub provider_child: Option<Box<ProviderChildStart>>,
    }
}

run_queued_payload! {
    /// A run created for an agent minted from a saved definition with this run.
    RunQueuedResolvedAgentPayload {
        /// The agent the run mints.
        #[garde(dive)]
        pub resolved_agent: ResolvedAgent,
        /// Only a run for an agent already in the session names it by id.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub agent_id: Option<Never>,
        /// Only a run reached as a provider's own helper names that helper.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub provider_child: Option<Never>,
    }
}

/// A run created and placed in the queue. It names its agent exactly once: by id for an agent
/// already in the session, or as the agent minted from a saved definition with this run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
pub enum AgentRunQueuedPayload {
    /// For an agent already in the session.
    SessionAgent(#[garde(dive)] RunQueuedSessionAgentPayload),
    /// For an agent resolved from a definition.
    ResolvedAgent(#[garde(dive)] Box<RunQueuedResolvedAgentPayload>),
}

impl AgentRunQueuedPayload {
    /// The session the run is created in.
    pub fn session_id(&self) -> SessionId {
        match self {
            Self::SessionAgent(payload) => payload.session_id,
            Self::ResolvedAgent(payload) => payload.session_id,
        }
    }

    /// The run it creates.
    pub fn run_id(&self) -> RunId {
        match self {
            Self::SessionAgent(payload) => payload.run_id,
            Self::ResolvedAgent(payload) => payload.run_id,
        }
    }

    /// The run's version at creation.
    pub fn run_version(&self) -> SafeInt<0> {
        match self {
            Self::SessionAgent(payload) => payload.run_version,
            Self::ResolvedAgent(payload) => payload.run_version,
        }
    }

    /// The run whose call started it, `None` for a run no call started.
    pub fn parent_run_id(&self) -> Option<RunId> {
        match self {
            Self::SessionAgent(payload) => payload.parent_run_id,
            Self::ResolvedAgent(payload) => payload.parent_run_id,
        }
    }
}

/// The TypeScript module of a run's creation record.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "run/queued",
    doc: "The `agent.run.queued` payload: a run's creation, and the one durable record of how it \
          came to be.",
    definitions: &[
        Definition::read::<ChildRunProvenance>(),
        Definition::read::<ResolvedAgent>(),
        Definition::read::<ProviderChildStart>(),
        Definition::read::<AgentRunQueuedPayload>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
