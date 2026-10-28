//! The `agent.run.queued` payload: a run's creation, and the one durable record of how it came to
//! be.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::{IntoStaticStr, VariantArray};

use crate::agent::definition::{AgentId, AgentResolvedConfiguration};
use crate::agent::methods::agent_entry;
use crate::orchestration::OrchestrationRunConfig;
use crate::provider::account::record::ProviderAccountId;
use crate::provider::driver::methods::PROVIDER_WIRE_HANDLE_MAX_LEN;
use crate::run::id::RunId;
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
            /// The account the run was admitted against.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "ProviderAccountId")]
            pub admitted_provider_account_id: Option<ProviderAccountId>,
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

/// The TypeScript module of a run's creation record.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "run/queued",
    doc: "The `agent.run.queued` payload: a run's creation, and the one durable record of how it \
          came to be.",
    definitions: &[
        Definition::read::<ChildRunProvenance>(),
        Definition::read::<ResolvedAgent>(),
        Definition::read::<AgentRunQueuedPayload>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
