//! Workflow run records: the run's own record, reading one run with its steps, and the method table
//! of every method that reads, lists and keeps run records.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::approval::ApprovalDecision;
use crate::jsonrpc::refusal::RefusalCode;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::Never;
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::text::{ComposedText, NonEmptyText};
use crate::workflow::definition::document::{
    WorkflowDefinitionId, WorkflowEdgeId, WorkflowVersionId,
};
use crate::workflow::definition::item::WorkflowStepError;
use crate::workflow::run::attention::WorkflowRunAttentionListResponse;
use crate::workflow::run::id::WorkflowRunId;
use crate::workflow::run::list::{WorkflowRunListRequest, WorkflowRunListResponse};
use crate::workflow::run::pause::{WorkflowNewRunHoldUpdateRequest, WorkflowRunsPauseState};
use crate::workflow::run::retention::{
    WorkflowRunDeleteRequest, WorkflowRunDeleteResponse, WorkflowRunKeepSet,
    WorkflowRunPurgePreviewResponse, WorkflowRunPurgeRequest, WorkflowRunPurgeResponse,
};
use crate::workflow::run::snapshot::WorkflowRunEpoch;
use crate::workflow::run::step::record::{WorkflowCost, WorkflowStep};
use crate::workflow::run::trigger::{WorkflowRunMode, WorkflowStartedBy, WorkflowTriggerKind};

ts_constants! {
    /// `Delete run` on a new, running or waiting run or a failed run parked on its failed step, or
    /// on a chain's first run while a later run of its chain is one of those; nothing is deleted
    /// (`Cancel it first.`).
    WORKFLOW_RUN_NOT_DELETABLE_CODE = RefusalCode::WorkflowRunNotDeletable;
}

/// Where a going run is: the live step's place in the run, counted from 1 and never past `total`,
/// and its node's name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[garde(custom(|live: &Self, (): &()| {
    if live.index <= live.total {
        Ok(())
    } else {
        Err(garde::Error::new("the live step is within the run"))
    }
}))]
pub struct WorkflowLiveStep {
    /// The live step's place in the run.
    // `type` beside the reference keeps Ajv's strict types satisfied for `maximum`.
    #[schemars(extend("type" = "integer", "maximum" = { "$data": "1/total" }))]
    pub index: SafeInt<1>,
    /// How many steps the run has.
    pub total: SafeInt<1>,
    /// The live step's node's name.
    pub node_name: NonEmptyText,
}

/// The first run of a run's chain: runs a run starts join its chain, and a first run names itself.
/// The header links the first run only when it is another run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowChainRoot {
    /// The first run.
    pub run_id: WorkflowRunId,
    /// Its workflow.
    pub definition_id: WorkflowDefinitionId,
    /// Its workflow's name.
    pub workflow_name: NonEmptyText,
    /// When it started.
    #[garde(dive)]
    pub started_at: WireInstant,
    /// How many runs the chain has started from it, the first run included, which the chain's
    /// question and a held step's live line both read.
    pub run_count: SafeInt<1>,
}

/// The chain's question as its first run's page carries it: open, or answered with the decision and
/// the run count it was taken at, which its receipt reads (`Kept going at 100 runs`). It is
/// answered through `workflow.gate.resolve` naming no node: `approved` keeps the chain going,
/// `rejected` stops every run of it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum WorkflowChainQuestion {
    /// Asked and not answered.
    Open {},
    /// Answered.
    Answered {
        /// The answer.
        decision: ApprovalDecision,
        /// How many runs the chain had started when it was answered.
        run_count: SafeInt<1>,
        /// When it was answered.
        #[garde(dive)]
        answered_at: WireInstant,
    },
}

/// How many items went through one edge of the run's graph, summed over every pass.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowEdgeItemCount {
    /// The edge.
    pub edge_id: WorkflowEdgeId,
    /// How many items went through it.
    pub item_count: SafeInt<0>,
}

/// The end snapshot a finished run's `Open in Review` compares with its start: pinned to the
/// execution whose two snapshots are compared, or missing with the daemon's words for why it could
/// not be taken, and `Open in Review` stays in place saying so.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorkflowRunReview {
    /// Taken.
    Pinned {
        /// The execution whose start and end snapshots are compared.
        epoch: WorkflowRunEpoch,
    },
    /// Not taken.
    Missing {
        /// Why the end snapshot could not be taken.
        reason: ComposedText,
    },
}

/// Declares a contract that carries the members a run's record carries whatever its status, spelled
/// here once, then the contract's own.
macro_rules! workflow_run {
    ($(#[$attribute:meta])+ pub struct $name:ident { $($own:tt)* }) => {
        $(#[$attribute])+
        pub struct $name {
            /// The run.
            pub workflow_run_id: WorkflowRunId,
            /// The session it lives in: the chat that started it, the session the workflow owns
            /// for a run nobody started from a chat, or a sub-workflow's parent's.
            pub session_id: SessionId,
            /// The workflow it came from; a run whose definition was deleted still reads.
            pub definition_id: WorkflowDefinitionId,
            /// The version it pins.
            pub workflow_version_id: WorkflowVersionId,
            /// How it was started.
            pub mode: WorkflowRunMode,
            /// The kind of trigger node that started it.
            pub trigger_kind: WorkflowTriggerKind,
            /// Who or what started it.
            pub started_by: WorkflowStartedBy,
            /// The Keep mark, which `Delete runs older than…` leaves.
            pub keep: bool,
            /// When it started.
            #[garde(dive)]
            pub started_at: WireInstant,
            $($own)*
        }
    };
}

/// Declares each pair of a run's shapes: the record's, an arm of [`WorkflowRun`], and the read's,
/// an arm of [`WorkflowRunReadResponse`], which adds the read's members and its own. `ends` are the
/// members both carry past the run's own: its end and its error.
macro_rules! workflow_run_shapes {
    ($(
        $(#[doc = $record_doc:literal])+
        pub struct $record:ident;
        $(#[doc = $read_doc:literal])+
        pub struct $read:ident { $($read_own:tt)* }
        ends { $($ends:tt)* }
    )+) => {$(
        workflow_run! {
            $(#[doc = $record_doc])+
            #[derive(
                Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate,
            )]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            #[schemars(inline)]
            #[garde(allow_unvalidated)]
            pub struct $record { $($ends)* }
        }

        workflow_run! {
            $(#[doc = $read_doc])+
            #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            #[schemars(inline)]
            #[garde(allow_unvalidated)]
            pub struct $read {
                /// The first run of the run's chain; its own id on a first run.
                #[garde(dive)]
                pub chain_root: WorkflowChainRoot,
                /// True for a run in a project's repository, which records its checkout and
                /// snapshot points so `Open in Review` opens its changes; false for a chat's run in
                /// the chat's own folder and a `None` run.
                pub execution_context_captured: bool,
                /// The session a failed step was opened in to be fixed, linked for the life of the
                /// run.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "SessionId")]
                pub fix_session_id: Option<SessionId>,
                /// Every step, one per execution of one node, from which the page draws its graph
                /// and its step panel.
                #[garde(dive)]
                pub steps: Vec<WorkflowStep>,
                /// Summed from the steps' stored amounts; absent where no provider was billed.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "WorkflowCost")]
                pub cost: Option<WorkflowCost>,
                /// Every edge items went through.
                pub edge_item_counts: Vec<WorkflowEdgeItemCount>,
                /// On the chain's first run, the chain's question once one has been asked.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "WorkflowChainQuestion")]
                #[garde(dive)]
                pub chain_question: Option<WorkflowChainQuestion>,
                $($read_own)*
                $($ends)*
            }
        }
    )+};
}

workflow_run_shapes! {
    /// A going run, new, running or waiting: it carries no end and no error.
    pub struct WorkflowGoingRun;
    /// A going run's read: the step it is on, and no review, since it has not ended.
    pub struct WorkflowGoingRunReadResponse {
        /// The step it is on.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WorkflowLiveStep")]
        #[garde(dive)]
        pub live_step: Option<WorkflowLiveStep>,
        /// Never present: only a finished run is reviewed.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub review: Option<Never>,
    }
    ends {
        /// Never present: a going run has not ended.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub finished_at: Option<Never>,
        /// Never present: only a run that failed, was canceled or crashed says why.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub error: Option<Never>,
    }

    /// A failed run: its end once it has ended, and why it failed. One parked on its failed step
    /// has not ended and carries no end, and `Cancel` and `Resume` still act on it.
    pub struct WorkflowFailedRun;
    /// A failed run's read: no live step, and its review once it has ended.
    pub struct WorkflowFailedRunReadResponse {
        /// Never present: only a going run has a live step.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub live_step: Option<Never>,
        /// Once it has ended with its checkout captured, the snapshots `Open in Review` compares.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WorkflowRunReview")]
        pub review: Option<WorkflowRunReview>,
    }
    ends {
        /// When it ended; absent while it is parked on its failed step.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WireInstant")]
        #[garde(dive)]
        pub finished_at: Option<WireInstant>,
        /// Why it failed: the run cap or the retry bound, where one failed it.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WorkflowStepError")]
        #[garde(dive)]
        pub error: Option<WorkflowStepError>,
    }

    /// A run that succeeded: its end, and no error.
    pub struct WorkflowSucceededRun;
    /// A succeeded run's read: no live step, and its review where its checkout was captured.
    pub struct WorkflowSucceededRunReadResponse {
        /// Never present: only a going run has a live step.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub live_step: Option<Never>,
        /// Where its checkout was captured, the snapshots `Open in Review` compares.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WorkflowRunReview")]
        pub review: Option<WorkflowRunReview>,
    }
    ends {
        /// When it ended.
        #[garde(dive)]
        pub finished_at: WireInstant,
        /// Never present: a run that succeeded has nothing to say why.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub error: Option<Never>,
    }

    /// A run that was canceled or crashed: its end and, where one is kept, why; a cancel carries
    /// the person's reason as its message.
    pub struct WorkflowStoppedRun;
    /// A canceled or crashed run's read: no live step, and its review where its checkout was
    /// captured.
    pub struct WorkflowStoppedRunReadResponse {
        /// Never present: only a going run has a live step.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub live_step: Option<Never>,
        /// Where its checkout was captured, the snapshots `Open in Review` compares.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WorkflowRunReview")]
        pub review: Option<WorkflowRunReview>,
    }
    ends {
        /// When it ended.
        #[garde(dive)]
        pub finished_at: WireInstant,
        /// Why it stopped, where one is kept.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WorkflowStepError")]
        #[garde(dive)]
        pub error: Option<WorkflowStepError>,
    }
}

/// One workflow run as its row records it, told apart by its `status`: the session it lives in,
/// the version it pins, how and by whom it was started, its Keep mark, when it started and ended,
/// and, on a run that failed, was canceled or crashed, why. It carries its end exactly once it has
/// ended.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum WorkflowRun {
    /// Started, with no step run yet.
    New(#[garde(dive)] WorkflowGoingRun),
    /// A step is running.
    Running(#[garde(dive)] WorkflowGoingRun),
    /// Held by a person, a chain's question or a spent provider account.
    Waiting(#[garde(dive)] WorkflowGoingRun),
    /// Ended with every step done.
    Succeeded(#[garde(dive)] WorkflowSucceededRun),
    /// Failed, ended or parked on its failed step.
    Failed(#[garde(dive)] WorkflowFailedRun),
    /// Ended by a cancel.
    Canceled(#[garde(dive)] WorkflowStoppedRun),
    /// Ended because the daemon stopped while it ran.
    Crashed(#[garde(dive)] WorkflowStoppedRun),
}

/// The `workflow.run.read` input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowRunReadRequest {
    /// The run.
    pub workflow_run_id: WorkflowRunId,
}

/// The `workflow.run.read` result: the run's record with its header facts and every step, from
/// which the page draws its graph and its step panel. A waiting run carries the step that waits,
/// only a finished run whose checkout was captured carries a review, and the chain's question sits
/// only on the chain's first run.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(tag = "status", rename_all = "camelCase")]
#[garde(allow_unvalidated)]
#[garde(custom(|run: &Self, (): &()| run.check_members()))]
#[schemars(extend("allOf" = [
    {
        "if": {
            "type": "object",
            "properties": { "status": { "const": "waiting" } },
            "required": ["status"],
        },
        "then": {
            "type": "object",
            "properties": { "steps": {
                "type": "array",
                "contains": {
                    "type": "object",
                    "properties": { "status": { "const": "waiting" } },
                    "required": ["status"],
                },
            } },
        },
    },
    {
        "if": { "type": "object", "required": ["review"] },
        "then": {
            "type": "object",
            "properties": { "executionContextCaptured": { "const": true } },
            "required": ["finishedAt"],
        },
    },
    {
        "if": { "type": "object", "required": ["chainQuestion"] },
        "then": {
            "type": "object",
            "properties": { "chainRoot": {
                "type": "object",
                "properties": { "runId": { "const": { "$data": "2/workflowRunId" } } },
            } },
        },
    },
]))]
pub enum WorkflowRunReadResponse {
    /// Started, with no step run yet.
    New(#[garde(dive)] WorkflowGoingRunReadResponse),
    /// A step is running.
    Running(#[garde(dive)] WorkflowGoingRunReadResponse),
    /// Held by a person, a chain's question or a spent provider account.
    Waiting(#[garde(dive)] WorkflowGoingRunReadResponse),
    /// Ended with every step done.
    Succeeded(#[garde(dive)] WorkflowSucceededRunReadResponse),
    /// Failed, ended or parked on its failed step.
    Failed(#[garde(dive)] WorkflowFailedRunReadResponse),
    /// Ended by a cancel.
    Canceled(#[garde(dive)] WorkflowStoppedRunReadResponse),
    /// Ended because the daemon stopped while it ran.
    Crashed(#[garde(dive)] WorkflowStoppedRunReadResponse),
}

impl WorkflowRunReadResponse {
    /// Holds the rules across the read's members: a waiting run carries the step that waits, a
    /// review sits only on a finished run whose checkout was captured, and the chain's question
    /// only on the chain's first run.
    fn check_members(&self) -> garde::Result {
        let (workflow_run_id, chain_root, has_chain_question, steps, is_reviewable) = match self {
            Self::New(run) | Self::Running(run) | Self::Waiting(run) => (
                &run.workflow_run_id,
                &run.chain_root,
                run.chain_question.is_some(),
                &run.steps,
                true,
            ),
            Self::Failed(run) => (
                &run.workflow_run_id,
                &run.chain_root,
                run.chain_question.is_some(),
                &run.steps,
                run.review.is_none()
                    || (run.execution_context_captured && run.finished_at.is_some()),
            ),
            Self::Succeeded(run) => (
                &run.workflow_run_id,
                &run.chain_root,
                run.chain_question.is_some(),
                &run.steps,
                run.review.is_none() || run.execution_context_captured,
            ),
            Self::Canceled(run) | Self::Crashed(run) => (
                &run.workflow_run_id,
                &run.chain_root,
                run.chain_question.is_some(),
                &run.steps,
                run.review.is_none() || run.execution_context_captured,
            ),
        };
        if matches!(self, Self::Waiting(_))
            && !steps
                .iter()
                .any(|step| matches!(step, WorkflowStep::Waiting(_)))
        {
            return Err(garde::Error::new(
                "a waiting run carries the step that waits",
            ));
        }
        if !is_reviewable {
            return Err(garde::Error::new(
                "only a finished run whose checkout was captured is reviewed",
            ));
        }
        if has_chain_question && chain_root.run_id != *workflow_run_id {
            return Err(garde::Error::new(
                "the chain's question sits on the chain's first run",
            ));
        }
        Ok(())
    }
}

methods! {
    /// The `workflow.*` methods that read, list and keep run records. `workflow.run.attention.list`
    /// takes no members: the runs table's filters never narrow it.
    pub const WORKFLOW_RUN_RECORD_METHOD_DESCRIPTORS = [
        /// Reads one run with its steps.
        WorkflowRunRead = query "workflow.run.read" {
            mutating: false,
            params: WorkflowRunReadRequest,
            result: WorkflowRunReadResponse,
            refusals: [WorkflowRunNotFound],
        },
        /// Lists one page of runs under the runs table's filters, with the count of all they match.
        WorkflowRunList = query "workflow.run.list" {
            mutating: false,
            params: WorkflowRunListRequest,
            result: WorkflowRunListResponse,
            refusals: [SessionNotFound, WorkflowDefinitionNotFound, WorkflowVersionNotFound, WorkflowCursorUnresolvable],
        },
        /// Deletes one ended run with its steps and snapshots.
        WorkflowRunDelete = mutation "workflow.run.delete" {
            mutating: true,
            params: WorkflowRunDeleteRequest,
            result: WorkflowRunDeleteResponse,
            refusals: [WorkflowRunNotFound, WorkflowRunNotDeletable],
        },
        /// Counts what deleting the runs older than an instant would remove and leave.
        WorkflowRunPurgePreview = query "workflow.run.purge.preview" {
            mutating: false,
            params: WorkflowRunPurgeRequest,
            result: WorkflowRunPurgePreviewResponse,
            refusals: [],
        },
        /// Deletes the runs older than an instant, leaving kept and unfinished ones.
        WorkflowRunPurge = mutation "workflow.run.purge" {
            mutating: true,
            params: WorkflowRunPurgeRequest,
            result: WorkflowRunPurgeResponse,
            refusals: [],
        },
        /// Marks a run Keep, or clears the mark.
        WorkflowRunKeepUpdate = mutation "workflow.run.keep.update" {
            mutating: true,
            params: WorkflowRunKeepSet,
            result: WorkflowRunKeepSet,
            refusals: [WorkflowRunNotFound],
        },
        /// Lists the runs that need someone, above the runs table and outside its filters.
        WorkflowRunAttentionList = query "workflow.run.attention.list" {
            mutating: false,
            params: EmptyPayload,
            result: WorkflowRunAttentionListResponse,
            refusals: [],
        },
        /// Puts the hold on starting new runs, or lifts it.
        WorkflowNewRunHoldUpdate = mutation "workflow.newRunHold.update" {
            mutating: true,
            params: WorkflowNewRunHoldUpdateRequest,
            result: WorkflowRunsPauseState,
            refusals: [],
        },
    ];
}

/// The TypeScript module of the run records and the run record methods' table.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/run/records",
    doc: "Workflow run records: the run's own record, reading one run with its steps, and the \
          method table of every method that reads, lists and keeps run records.",
    definitions: &[
        Definition::read::<WorkflowLiveStep>().checked(),
        Definition::read::<WorkflowChainRoot>().checked(),
        Definition::read::<WorkflowChainQuestion>().checked(),
        Definition::read::<WorkflowEdgeItemCount>(),
        Definition::read::<WorkflowRunReview>(),
        Definition::read::<WorkflowRun>(),
        Definition::read::<WorkflowRunReadRequest>().checked(),
        Definition::read::<WorkflowRunReadResponse>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&WORKFLOW_RUN_RECORD_METHOD_DESCRIPTORS],
};
