//! The one live stream the workflows screens read, `workflow.subscribe`: the hold on starting new
//! runs, run, step and schedule changes, and a definition changed or removed, with its method
//! table.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::jsonrpc::streaming::SubscribeAckResponse;
use crate::method::methods;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::list::BoundedVec;
use crate::workflow::definition::document::{WorkflowDefinitionId, WorkflowNodeId};
use crate::workflow::definition::methods::WorkflowDefinitionSummary;
use crate::workflow::run::id::WorkflowRunId;
use crate::workflow::run::list::WorkflowRunSummary;
use crate::workflow::run::step::record::WorkflowStep;

/// The `workflow.subscribe` input: one subscription for the whole runs list and the canvas
/// overlay, never one per row. Without `sessionId` it covers every run this daemon ran.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowSubscribeRequest {
    /// The session whose runs it follows; absent for every run.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SessionId")]
    pub session_id: Option<SessionId>,
    /// The workflow whose runs and schedule it follows; absent for every workflow.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WorkflowDefinitionId")]
    pub definition_id: Option<WorkflowDefinitionId>,
}

/// What happened to a schedule: armed, disarmed, fired, or a fire the overlap policy skipped, which
/// shows on the workflow's row and its trigger's panel and never becomes a run.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowScheduleChange {
    /// Armed.
    Armed,
    /// Disarmed.
    Disarmed,
    /// Fired, starting a run.
    Fired,
    /// Skipped by the overlap policy.
    Skipped,
}

/// One `workflow.subscribe` frame. The stream holds only its place, never a queue: the current hold
/// comes first, then a state frame (`runsPause`, `run`, `step`, `definition`) carries a key's
/// newest value when the lane has credit, so a slow reader may see a run or step skip a state. A
/// removal (`runsRemoved`, `definitionRemoved`) and a schedule's frame are events, each sent and
/// never folded into a later one, so no view keeps a row that is gone or misses a skipped fire.
/// There is no cursor and no dropped mark.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorkflowSubscribeNotification {
    /// The hold on starting new runs, and how many starts wait behind it.
    RunsPause {
        /// Whether the hold is on.
        paused: bool,
        /// How many starts wait behind it.
        waiting_start_count: SafeInt<0>,
    },
    /// A run's newest summary.
    Run {
        /// The run.
        run: WorkflowRunSummary,
    },
    /// Runs deleted.
    RunsRemoved {
        /// The runs.
        workflow_run_ids: BoundedVec<WorkflowRunId, 1, { usize::MAX }>,
    },
    /// A step's newest record.
    Step {
        /// The step's run.
        workflow_run_id: WorkflowRunId,
        /// The step.
        step: Box<WorkflowStep>,
    },
    /// A schedule armed, disarmed, fired or skipped.
    Schedule {
        /// The workflow.
        definition_id: WorkflowDefinitionId,
        /// The schedule's trigger node.
        node_id: WorkflowNodeId,
        /// What happened.
        event: WorkflowScheduleChange,
        /// The occurrence it happened for.
        scheduled_at: WireInstant,
        /// The next fire, while the schedule stays armed.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WireInstant")]
        next_fire_at: Option<WireInstant>,
    },
    /// A workflow's newest summary.
    Definition {
        /// The workflow.
        definition: WorkflowDefinitionSummary,
    },
    /// A workflow deleted.
    DefinitionRemoved {
        /// The workflow.
        definition_id: WorkflowDefinitionId,
    },
}

methods! {
    /// The `workflow.subscribe` method's table.
    pub const WORKFLOW_SUBSCRIPTION_METHOD_DESCRIPTORS = [
        /// Follows the runs, steps, schedules and definitions the workflows screens show; the hold
        /// on starting new runs comes first.
        WorkflowSubscribe = subscription "workflow.subscribe" {
            mutating: false,
            params: WorkflowSubscribeRequest,
            result: SubscribeAckResponse,
            emission: WorkflowSubscribeNotification,
            refusals: [SessionNotFound, WorkflowNotFound, TransportSubscriptionLimitReached],
        },
    ];
}

/// The TypeScript module of `workflow.subscribe`.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/subscription",
    doc: "The one live stream the workflows screens read, `workflow.subscribe`: the hold on \
          starting new runs, run, step and schedule changes, and a definition changed or removed, \
          with its method table.",
    definitions: &[
        Definition::read::<WorkflowSubscribeRequest>().checked(),
        Definition::read::<WorkflowScheduleChange>(),
        Definition::read::<WorkflowSubscribeNotification>().checked(),
    ],
    constants: &[],
    method_tables: &[&WORKFLOW_SUBSCRIPTION_METHOD_DESCRIPTORS],
};
