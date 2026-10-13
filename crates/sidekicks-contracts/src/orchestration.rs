//! The session's agent tree as a client reads it, run admission under an agent and its refusal
//! record, and the `orchestration.*` methods.
//!
//! The daemon keeps one parent-to-child index per session, built from the provider stream, because
//! neither provider lists its children back on a resume. That index is the one source of the child
//! tree, every fan-out count and each agent's spend; `orchestration.childRunLinkRead` is the only
//! method that reads it. How a child was reached stays in the index and is never sent: the screen
//! draws the tree, provider, model and the agent asked, never a mechanism word.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::agent::definition::{AgentDefinitionId, AgentId};
use crate::agent::tree::{AgentTreeMember, ChildHandle};
use crate::method::methods;
use crate::provider::driver::length_limits::DRIVER_TOOL_NAME_MAX_LEN;
use crate::provider::driver::methods::{DRIVER_WIRE_REASON_MAX_LEN, DRIVER_WIRE_TOKEN_MAX_LEN};
use crate::run::id::RunId;
use crate::run::state::RunState;
use crate::session::cost::{
    OrchestrationBudgetReadRequest, OrchestrationBudgetState, SessionCostReceipt,
    SessionCostReceiptRequest, TokensPerRun, UsdMicros,
};
use crate::session::id::SessionId;
use crate::transcript::child_run_summary::refuse_self_parenting_run;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::list::BoundedVec;
use crate::wire::text::FreeFormText;

/// Why the daemon itself interrupted a run: a step, spend or token limit the person set was
/// reached, the run's workflow phase was canceled, or the daemon restarted while the run was a
/// child held in a pause. The person's own interrupt has none.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum InterruptReason {
    /// The step limit was reached.
    StepLimit,
    /// The spend limit was reached.
    SpendLimit,
    /// The token limit was reached.
    TokenLimit,
    /// The run's workflow phase was canceled.
    WorkflowPhaseCanceled,
    /// The daemon restarted while the run was a child held in a pause.
    DaemonRestart,
}

/// A run's own limits: `tokenLimit` is its `Tokens per run`, input and output together, absent
/// meaning unlimited. A request's override, and the value admission resolves and keeps on the
/// run's creation record.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrchestrationRunConfig {
    /// The run's token limit.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "TokensPerRun")]
    pub token_limit: Option<TokensPerRun>,
}

/// Declares one arm of a run create request with the members every arm repeats.
macro_rules! run_create_request {
    ($(#[doc = $doc:literal])+ $name:ident { $($target:tt)* }) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[schemars(inline)]
        pub struct $name {
            /// The session.
            pub session_id: SessionId,
            $($target)*
            /// The run the new run is a child of.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "RunId")]
            pub parent_run_id: Option<RunId>,
            /// The run's limits, over the session's defaults.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "OrchestrationRunConfig")]
            pub config: Option<OrchestrationRunConfig>,
        }
    };
}

run_create_request! {
    /// A run create aimed at a live agent in the session.
    AgentRunCreateRequest {
        /// The agent.
        pub target_agent_id: AgentId,
    }
}

run_create_request! {
    /// A run create aimed at a saved definition the daemon resolves when it queues the run.
    DefinitionRunCreateRequest {
        /// The definition.
        pub target_definition_id: AgentDefinitionId,
    }
}

/// `orchestration.runCreate`: admits a run under an agent, called by the daemon's own paths and
/// the SDK, never by a screen control. No count limits admission or depth: a refusal is the
/// provider's own or an unresolved target. It names exactly one target.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum OrchestrationRunCreateRequest {
    /// Aimed at a live agent.
    Agent(AgentRunCreateRequest),
    /// Aimed at a saved definition.
    Definition(DefinitionRunCreateRequest),
}

/// The admitted run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrchestrationRunCreateResponse {
    /// The run.
    pub run_id: RunId,
    /// Its state.
    pub state: RunState,
    /// Its parent run.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "RunId")]
    pub parent_run_id: Option<RunId>,
}

/// A refusing error code, as a refusal record names it.
pub type RefusalReasonCode = FreeFormText<DRIVER_WIRE_TOKEN_MAX_LEN>;

/// A refusal's words.
pub type RefusalDetail = FreeFormText<DRIVER_WIRE_REASON_MAX_LEN>;

/// The `orchestration.rejected` payload: a run create admission refused. It names no run, because
/// a refusal leaves none. `reason` is the refusing error code, and `detail` its words.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrchestrationRejectedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The agent the run was aimed at.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "AgentId")]
    pub target_agent_id: Option<AgentId>,
    /// The run it would have been a child of.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "RunId")]
    pub parent_run_id: Option<RunId>,
    /// The refusing error code.
    pub reason: RefusalReasonCode,
    /// Its words.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "RefusalDetail")]
    pub detail: Option<RefusalDetail>,
}

/// `orchestration.childRunLinkRead`: the session whose whole tree is read.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChildRunLinkReadRequest {
    /// The session.
    pub session_id: SessionId,
}

/// What a child's head reads after its name: the model, the effort as one word, the agent that
/// was asked where the child was a peer call, its tokens and spend, when it started, and its
/// ancestry from the lead down to its parent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ChildRunHead {
    /// The model.
    pub model_id: FreeFormText<DRIVER_WIRE_TOKEN_MAX_LEN>,
    /// The effort, as one word.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<DRIVER_WIRE_TOKEN_MAX_LEN>")]
    pub effort: Option<FreeFormText<DRIVER_WIRE_TOKEN_MAX_LEN>>,
    /// The agent that was asked, where the child was a peer call.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<DRIVER_TOOL_NAME_MAX_LEN>")]
    pub via_agent_name: Option<FreeFormText<DRIVER_TOOL_NAME_MAX_LEN>>,
    /// Its tokens.
    pub tokens: SafeInt<0>,
    /// Its spend.
    pub spend_usd_micros: UsdMicros,
    /// When it started.
    #[garde(dive)]
    pub started_at: WireInstant,
    /// Its ancestry, from the lead down to its parent.
    pub ancestry: BoundedVec<AgentTreeMember, 1, { usize::MAX }>,
}

/// One child in the tree: a run of its own under an agent, linked to exactly one parent run, or a
/// provider's own helper inside its parent's run, addressed by its handle. No run is its own
/// parent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
#[garde(custom(no_run_is_its_own_parent))]
pub enum ChildRunLink {
    /// A run of its own under an agent.
    Run {
        /// The child run.
        child_run_id: RunId,
        /// Its parent run; never the child itself.
        #[schemars(extend("type" = "string", "not" = { "const": { "$data": "1/childRunId" } }))]
        parent_run_id: RunId,
        /// The agent it runs under.
        agent_id: AgentId,
        /// Its state.
        state: RunState,
        /// Its head.
        #[garde(dive)]
        head: ChildRunHead,
    },
    /// A provider's own helper inside its parent's run.
    ProviderChild {
        /// The run it runs in.
        run_id: RunId,
        /// Its handle.
        child_handle: ChildHandle,
        /// The helper it is a child of, when it is not the run's own.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "ChildHandle")]
        parent_child_handle: Option<ChildHandle>,
        /// Its state.
        state: RunState,
        /// Its head.
        #[garde(dive)]
        head: ChildRunHead,
    },
}

fn no_run_is_its_own_parent(link: &ChildRunLink, (): &()) -> garde::Result {
    match link {
        ChildRunLink::Run {
            child_run_id,
            parent_run_id,
            ..
        } => refuse_self_parenting_run(child_run_id, parent_run_id),
        ChildRunLink::ProviderChild { .. } => Ok(()),
    }
}

/// A child run the daemon refused to create, folded from the session's refusal events. A refusal
/// leaves no run, queue item or link, so this fold is the only record of work that was asked for
/// and denied. `reason` is the refusing error code.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ChildRunRejection {
    /// The run it would have been a child of.
    pub parent_run_id: RunId,
    /// The agent it was aimed at.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "AgentId")]
    pub target_agent_id: Option<AgentId>,
    /// The refusing error code.
    pub reason: RefusalReasonCode,
    /// Its words.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "RefusalDetail")]
    pub detail: Option<RefusalDetail>,
    /// When it was refused.
    #[garde(dive)]
    pub occurred_at: WireInstant,
}

/// The agents badge's figures, supplied by the daemon because the screen may hold only part of
/// the list: the children running now, the children dispatched in all, and the children waiting
/// on an approval. Neither the live nor the waiting count exceeds the total.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[garde(custom(counts_stay_within_the_total))]
pub struct ChildRunCounts {
    /// The children running now.
    // `type` beside the reference keeps Ajv's strict types satisfied for `maximum`.
    #[schemars(extend("type" = "integer", "maximum" = { "$data": "1/total" }))]
    pub live: SafeInt<0>,
    /// The children dispatched in all.
    pub total: SafeInt<0>,
    /// The children waiting on an approval.
    #[schemars(extend("type" = "integer", "maximum" = { "$data": "1/total" }))]
    pub waiting: SafeInt<0>,
}

fn counts_stay_within_the_total(counts: &ChildRunCounts, (): &()) -> garde::Result {
    if counts.live <= counts.total && counts.waiting <= counts.total {
        Ok(())
    } else {
        Err(garde::Error::new(
            "neither the live nor the waiting count exceeds the total",
        ))
    }
}

/// The whole tree, the badge's figures, and the refused creates.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChildRunLinkReadResponse {
    /// The tree.
    #[garde(dive)]
    pub children: Vec<ChildRunLink>,
    /// The badge's figures.
    #[garde(dive)]
    pub counts: ChildRunCounts,
    /// The refused creates.
    #[garde(dive)]
    pub rejected_creates: Vec<ChildRunRejection>,
}

methods! {
    /// The `orchestration.*` methods. The client re-reads the tree on each child started or
    /// completed, run queued, create refused and run state change.
    pub const ORCHESTRATION_METHOD_DESCRIPTORS = [
        /// Admits a run under an agent.
        OrchestrationRunCreate = mutation "orchestration.runCreate" {
            mutating: true,
            params: OrchestrationRunCreateRequest,
            result: OrchestrationRunCreateResponse,
            refusals: [],
        },
        /// Reads the session's whole agent tree.
        OrchestrationChildRunLinkRead = query "orchestration.childRunLinkRead" {
            mutating: false,
            params: ChildRunLinkReadRequest,
            result: ChildRunLinkReadResponse,
            refusals: [],
        },
        /// Reads the session's limits and spend.
        OrchestrationBudgetRead = query "orchestration.budgetRead" {
            mutating: false,
            params: OrchestrationBudgetReadRequest,
            result: OrchestrationBudgetState,
            refusals: [],
        },
        /// Reads the session's cost receipt.
        OrchestrationCostReceiptRead = query "orchestration.costReceiptRead" {
            mutating: false,
            params: SessionCostReceiptRequest,
            result: SessionCostReceipt,
            refusals: [],
        },
    ];
}

/// The TypeScript module of the agent tree's reads and run admission.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "orchestration",
    doc: "The session's agent tree as a client reads it, run admission under an agent and its \
          refusal record, and the `orchestration.*` methods.",
    definitions: &[
        Definition::read::<InterruptReason>(),
        Definition::read::<OrchestrationRunConfig>().checked(),
        Definition::read::<OrchestrationRunCreateRequest>(),
        Definition::read::<OrchestrationRunCreateResponse>(),
        Definition::read::<OrchestrationRejectedPayload>().checked(),
        Definition::read::<ChildRunLinkReadRequest>(),
        Definition::read::<ChildRunHead>(),
        Definition::read::<ChildRunLink>().checked(),
        Definition::read::<ChildRunRejection>(),
        Definition::read::<ChildRunCounts>(),
        Definition::read::<ChildRunLinkReadResponse>().checked(),
    ],
    constants: &[],
    method_tables: &[&ORCHESTRATION_METHOD_DESCRIPTORS],
};
