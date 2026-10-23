//! What the working line reads about one turn: the tokens received so far and the agent's own task
//! list. Both are live readings of one turn that end with it, not projections of the session log,
//! and both are folded from frames the provider already sends: neither adds a provider request and
//! neither is polled.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::jsonrpc::streaming::SubscribeAcknowledgmentResponse;
use crate::method::methods;
use crate::provider::driver::methods::PROVIDER_WIRE_HANDLE_MAX_LEN;
use crate::run::id::RunId;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::integer::SafeInt;
use crate::wire::text::{NonEmptyText, branded_free_form_text};

branded_free_form_text! {
    /// A provider's id of one turn.
    pub struct ProviderTurnId(PROVIDER_WIRE_HANDLE_MAX_LEN);
}

/// The run whose current turn an `agent.turn.usage.subscribe` or `agent.turn.task.subscribe`
/// subscription follows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentTurnSubscribeRequest {
    /// The session.
    pub session_id: SessionId,
    /// The run.
    pub run_id: RunId,
}

/// The tokens received this turn: the provider's own output count for each model round, summed
/// across the turn, with reasoning already inside it. Cumulative rather than a delta, so a
/// subscriber that joins mid-turn reads the true figure.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct TurnUsageUpdate {
    /// The run.
    pub run_id: RunId,
    /// The turn.
    pub turn_id: ProviderTurnId,
    /// Tokens received so far.
    pub tokens_received: SafeInt<0>,
}

/// Where one task on the agent's list stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TurnTaskState {
    /// Not started.
    NotStarted,
    /// In progress.
    InProgress,
    /// Done.
    Done,
}

/// One task on the agent's list, in the agent's own words.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnTask {
    /// The task.
    pub text: NonEmptyText,
    /// Where it stands.
    pub state: TurnTaskState,
}

/// The turn's whole task list in the agent's order, sent whole on every change, because a provider
/// replaces its list rather than patching it. The list goes when the turn is interrupted and
/// returns with the next turn's list.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct TurnTasksUpdate {
    /// The run.
    pub run_id: RunId,
    /// The turn.
    pub turn_id: ProviderTurnId,
    /// The tasks.
    pub tasks: Vec<TurnTask>,
}

methods! {
    /// The running turn's two subscriptions, which follow one run's current turn.
    pub const TURN_METHOD_DESCRIPTORS = [
        /// The tokens received this turn.
        AgentTurnUsageSubscribe = subscription "agent.turn.usage.subscribe" {
            mutating: false,
            params: AgentTurnSubscribeRequest,
            result: SubscribeAcknowledgmentResponse,
            emission: TurnUsageUpdate,
            refusals: [SessionNotFound, AgentRunNotFound],
        },
        /// The turn's task list.
        AgentTurnTaskSubscribe = subscription "agent.turn.task.subscribe" {
            mutating: false,
            params: AgentTurnSubscribeRequest,
            result: SubscribeAcknowledgmentResponse,
            emission: TurnTasksUpdate,
            refusals: [SessionNotFound, AgentRunNotFound],
        },
    ];
}

/// The TypeScript module of a turn's live readings.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "turn",
    doc: "What the working line reads about one turn: the tokens received so far and the agent's \
          own task list.",
    definitions: &[
        Definition::read::<ProviderTurnId>(),
        Definition::read::<AgentTurnSubscribeRequest>().checked(),
        Definition::read::<TurnUsageUpdate>().checked(),
        Definition::read::<TurnTaskState>(),
        Definition::read::<TurnTask>(),
        Definition::read::<TurnTasksUpdate>().checked(),
    ],
    constants: &[],
    method_tables: &[&TURN_METHOD_DESCRIPTORS],
};
