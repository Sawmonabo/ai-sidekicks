//! The runs table's page: the `workflow.runList` filters, one row per run and the count of every
//! run the filters match.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::Never;
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::list::BoundedVec;
use crate::wire::text::{NonEmptyText, branded_text};
use crate::workflow::definition::document::{WorkflowDefinitionId, WorkflowVersionId};
use crate::workflow::run::id::WorkflowRunId;
use crate::workflow::run::records::WorkflowLiveStep;
use crate::workflow::run::status::WorkflowRunStatus;
use crate::workflow::run::step::record::WorkflowCost;
use crate::workflow::run::trigger::{WorkflowRunMode, WorkflowStartedBy, WorkflowTriggerKind};

/// The longest `workflow.runList` cursor accepted; a guard against pathological lengths.
const WORKFLOW_RUN_LIST_CURSOR_MAX_LEN: usize = 256;

branded_text! {
    /// Where the next `workflow.runList` page starts. The daemon writes it and owns its format; a
    /// client passes it back unchanged with the same filters.
    pub struct WorkflowRunListCursor(1..=WORKFLOW_RUN_LIST_CURSOR_MAX_LEN);
}

/// The `workflow.runList` input: the runs table's filters (workflow, status, trigger kind and date
/// range) and the version scope `Show runs` hands in, which comes only with the workflow it belongs
/// to. Without `sessionId` it lists every run this daemon ran.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[garde(custom(|request: &Self, (): &()| {
    if request.workflow_version_id.is_none() || request.definition_id.is_some() {
        Ok(())
    } else {
        Err(garde::Error::new("a version scope names the workflow it belongs to"))
    }
}))]
#[schemars(extend("type" = "object", "dependentRequired" = {
    "workflowVersionId": ["definitionId"],
}))]
pub struct WorkflowRunListRequest {
    /// The session whose runs are listed; absent, every run this daemon ran.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SessionId")]
    pub session_id: Option<SessionId>,
    /// The workflow whose runs are listed.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WorkflowDefinitionId")]
    pub definition_id: Option<WorkflowDefinitionId>,
    /// Only runs pinned to this version of that workflow; sent only with `definitionId`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WorkflowVersionId")]
    pub workflow_version_id: Option<WorkflowVersionId>,
    /// Only runs in one of these statuses.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "BoundedVec<WorkflowRunStatus, 1, { usize::MAX }>")]
    pub status: Option<BoundedVec<WorkflowRunStatus, 1, { usize::MAX }>>,
    /// Only runs started by one of these trigger kinds.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "BoundedVec<WorkflowTriggerKind, 1, { usize::MAX }>")]
    pub trigger_kind: Option<BoundedVec<WorkflowTriggerKind, 1, { usize::MAX }>>,
    /// Only runs started after this instant.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WireInstant")]
    #[garde(dive)]
    pub started_after: Option<WireInstant>,
    /// Only runs started before this instant.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WireInstant")]
    #[garde(dive)]
    pub started_before: Option<WireInstant>,
    /// The most runs on one page.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<1>")]
    pub limit: Option<SafeInt<1>>,
    /// Continue from this cursor.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WorkflowRunListCursor")]
    pub cursor: Option<WorkflowRunListCursor>,
}

/// Declares one shape of [`WorkflowRunSummary`]: the members a runs-table row carries whatever its
/// status, in the order the row reads them, then the shape's own.
macro_rules! workflow_run_summary {
    ($($(#[doc = $doc:literal])+ pub struct $name:ident { $($own:tt)* })+) => {$(
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[schemars(inline)]
        #[garde(allow_unvalidated)]
        pub struct $name {
            /// The run.
            pub workflow_run_id: WorkflowRunId,
            /// The session it lives in, which the row opens.
            pub session_id: SessionId,
            /// The workflow it came from, since a list answers with runs nobody named.
            pub definition_id: WorkflowDefinitionId,
            /// That workflow's name.
            pub definition_name: NonEmptyText,
            /// How it was started.
            pub mode: WorkflowRunMode,
            /// The kind of trigger node that started it, which the trigger column reads.
            pub trigger_kind: WorkflowTriggerKind,
            /// Who or what started it.
            pub started_by: WorkflowStartedBy,
            /// When it started.
            #[garde(dive)]
            pub started_at: WireInstant,
            /// How many steps it has run.
            pub step_count: SafeInt<0>,
            /// What it cost, with the account that paid; absent where no provider was billed.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "WorkflowCost")]
            pub cost: Option<WorkflowCost>,
            /// The Keep mark the row shows.
            pub keep: bool,
            $($own)*
        }
    )+};
}

workflow_run_summary! {
    /// A row of a new or running run: its live step, and no duration yet.
    pub struct WorkflowGoingRunSummary {
        /// Never present: a going run has not ended.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub duration_ms: Option<Never>,
        /// The step it is on.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WorkflowLiveStep")]
        #[garde(dive)]
        pub live_step: Option<WorkflowLiveStep>,
        /// Never present: only a waiting run names a cause.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub wait_cause: Option<Never>,
        /// Never present: only an account wait resumes itself.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub resume_at: Option<Never>,
    }

    /// A row of a run waiting on a spent provider account: its live step and, where the wait armed
    /// one, the instant it resumes itself; where none is armed, no instant is invented.
    pub struct WorkflowAccountWaitingRunSummary {
        /// Never present: a waiting run has not ended.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub duration_ms: Option<Never>,
        /// The step it is on.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WorkflowLiveStep")]
        #[garde(dive)]
        pub live_step: Option<WorkflowLiveStep>,
        /// When the wait resumes itself, where one is armed.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WireInstant")]
        #[garde(dive)]
        pub resume_at: Option<WireInstant>,
    }

    /// A row of a run waiting on a person's approval, form or chat reply, or on its chain's
    /// question: its live step, and no instant, since only a person resumes it.
    pub struct WorkflowPersonWaitingRunSummary {
        /// Never present: a waiting run has not ended.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub duration_ms: Option<Never>,
        /// The step it is on.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WorkflowLiveStep")]
        #[garde(dive)]
        pub live_step: Option<WorkflowLiveStep>,
        /// Never present: only an account wait resumes itself.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub resume_at: Option<Never>,
    }

    /// A row of a failed run: its duration once it has ended, and none while it is parked on its
    /// failed step.
    pub struct WorkflowFailedRunSummary {
        /// How long it ran, in milliseconds; absent while it is parked on its failed step.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "SafeInt<0>")]
        pub duration_ms: Option<SafeInt<0>>,
        /// Never present: only a going run has a live step.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub live_step: Option<Never>,
        /// Never present: only a waiting run names a cause.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub wait_cause: Option<Never>,
        /// Never present: only an account wait resumes itself.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub resume_at: Option<Never>,
    }

    /// A row of a run that succeeded, was canceled or crashed: its duration, and no live step,
    /// which goes back to the finished step count when the run ends.
    pub struct WorkflowEndedRunSummary {
        /// How long it ran, in milliseconds.
        pub duration_ms: SafeInt<0>,
        /// Never present: only a going run has a live step.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub live_step: Option<Never>,
        /// Never present: only a waiting run names a cause.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub wait_cause: Option<Never>,
        /// Never present: only an account wait resumes itself.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub resume_at: Option<Never>,
    }
}

/// A waiting run's row, by what it waits on, so a wait on a person and a wait on a spent provider
/// account read apart.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(tag = "waitCause", rename_all = "snake_case")]
#[schemars(inline)]
pub enum WorkflowWaitingRunSummary {
    /// A person's approval.
    Approval(#[garde(dive)] WorkflowPersonWaitingRunSummary),
    /// A person's form.
    Form(#[garde(dive)] WorkflowPersonWaitingRunSummary),
    /// A person's chat reply.
    Reply(#[garde(dive)] WorkflowPersonWaitingRunSummary),
    /// A spent provider account.
    Account(#[garde(dive)] WorkflowAccountWaitingRunSummary),
    /// The chain's question.
    Chain(#[garde(dive)] WorkflowPersonWaitingRunSummary),
}

/// One row of the runs table, told apart by its `status`, carrying no version (the run's own page
/// reads it). A going run carries its live step and no duration, an ended one its duration, and a
/// failed run parked on its failed step neither.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum WorkflowRunSummary {
    /// Started, with no step run yet.
    New(#[garde(dive)] WorkflowGoingRunSummary),
    /// A step is running.
    Running(#[garde(dive)] WorkflowGoingRunSummary),
    /// Held by a person, a chain's question or a spent provider account.
    Waiting(#[garde(dive)] WorkflowWaitingRunSummary),
    /// Ended with every step done.
    Succeeded(#[garde(dive)] WorkflowEndedRunSummary),
    /// Failed, ended or parked on its failed step.
    Failed(#[garde(dive)] WorkflowFailedRunSummary),
    /// Ended by a cancel.
    Canceled(#[garde(dive)] WorkflowEndedRunSummary),
    /// Ended because the daemon stopped while it ran.
    Crashed(#[garde(dive)] WorkflowEndedRunSummary),
}

/// The `workflow.runList` result: one page of runs, each listed once across pages, and how many
/// runs the filters match in all, which the tab's count reads; never fewer than the page holds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowRunListResponse {
    /// The page's runs.
    #[garde(dive, custom(|runs: &Vec<WorkflowRunSummary>, (): &()| {
        if u64::try_from(runs.len()).is_ok_and(|count| count <= self.total_count.get()) {
            Ok(())
        } else {
            Err(garde::Error::new("a page holds no more runs than the total"))
        }
    }))]
    #[schemars(extend("maxItems" = { "$data": "1/totalCount" }))]
    pub runs: Vec<WorkflowRunSummary>,
    /// Where the next page starts; absent on the last page.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "WorkflowRunListCursor")]
    pub next_cursor: Option<WorkflowRunListCursor>,
    /// How many runs the filters match in all.
    pub total_count: SafeInt<0>,
}

/// The TypeScript module of the runs table's page.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/run/list",
    doc: "The runs table's page: the `workflow.runList` filters, one row per run and the count of \
          every run the filters match.",
    definitions: &[
        Definition::read::<WorkflowRunListCursor>(),
        Definition::read::<WorkflowRunListRequest>().checked(),
        Definition::read::<WorkflowRunSummary>().checked(),
        Definition::read::<WorkflowRunListResponse>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
