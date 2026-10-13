//! The step record every workflow run method and event shares: one execution of one node, with its
//! payload references, cost, spent account, question, resolution and review pause, and the key that
//! addresses it. A step is addressed by its run, its node, its attempt and which execution of that
//! node, because a retry runs a step again and a loop runs one node many times.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::agent::definition::AgentResolvedConfiguration;
use crate::artifacts::id::ArtifactId;
use crate::jsonrpc::byte_length::json_utf8_byte_length;
use crate::provider::account::record::{PROVIDER_ACCOUNT_LABEL_MAX_LEN, ProviderAccountId};
use crate::provider::name::ProviderName;
use crate::question::QuestionId;
use crate::run::control::ProcessExit;
use crate::session::cost::UsdMicros;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::id::UuidTextForm;
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::text::{ComposedText, FreeFormText};
use crate::wire::{Never, literal};
use crate::workflow::definition::document::WorkflowNodeId;
use crate::workflow::definition::document::item::{WorkflowItem, WorkflowStepError};
use crate::workflow::run::id::WorkflowRunId;
use crate::workflow::run::snapshot::{WorkflowRunEpoch, WorkflowRunPauseNumber};
use crate::workflow::run::status::WorkflowStepStatus;

ts_constants! {
    /// The most bytes a step payload is carried inline, counted on its JSON encoding. A larger
    /// payload is stored as an artifact and referenced, and the panel says which.
    pub const WORKFLOW_STEP_PAYLOAD_INLINE_BYTE_CAP: usize = 64 * 1024;
    /// How a person answers a step that waited on them.
    pub const WORKFLOW_STEP_RESOLUTION_KINDS: [WorkflowStepResolutionKind; 4] = [
        WorkflowStepResolutionKind::Approved,
        WorkflowStepResolutionKind::Rejected,
        WorkflowStepResolutionKind::Answered,
        WorkflowStepResolutionKind::Declined,
    ];
}

/// Refuses inline items whose JSON takes more than [`WORKFLOW_STEP_PAYLOAD_INLINE_BYTE_CAP`]
/// bytes: such a payload is stored as an artifact.
fn fits_inline<Items: Serialize>(items: &Items, (): &()) -> garde::Result {
    let byte_length = json_utf8_byte_length(items)
        .map_err(|error| garde::Error::new(format!("the items do not serialize: {error}")))?;
    if byte_length > WORKFLOW_STEP_PAYLOAD_INLINE_BYTE_CAP {
        Err(garde::Error::new(format!(
            "an inline payload is at most {WORKFLOW_STEP_PAYLOAD_INLINE_BYTE_CAP} bytes; this one \
             takes {byte_length}, so it is an artifact"
        )))
    } else {
        Ok(())
    }
}

/// A step payload by reference: inline items up to the cap, an artifact above it, which names how
/// many items it holds so a count is drawn without reading it. Step data is kept until the person
/// deletes the run or its session; nothing expires it on its own.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum WorkflowPayloadRef {
    /// The items themselves, at most [`WORKFLOW_STEP_PAYLOAD_INLINE_BYTE_CAP`] JSON bytes.
    Inline {
        /// The items.
        #[garde(dive, custom(fits_inline))]
        items: Vec<WorkflowItem>,
    },
    /// An artifact holding the items.
    Artifact {
        /// The artifact.
        artifact_id: ArtifactId,
        /// Its size in bytes.
        size_bytes: SafeInt<1>,
        /// How many items it holds.
        item_count: SafeInt<0>,
    },
}

/// What a step or a run cost, in whole micro-dollars, and the account that paid. Present only where
/// a provider was billed; a step that spent nothing carries none.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowCost {
    /// The cost.
    pub usd_micros: UsdMicros,
    /// The account that paid.
    pub provider_account_id: ProviderAccountId,
}

/// A spent provider account as a wait names it: its id, its provider and the label every surface
/// names an account by, so no account id reaches the screen.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowSpentAccount {
    /// The account.
    pub provider_account_id: ProviderAccountId,
    /// Its provider.
    pub provider: ProviderName,
    /// Its label.
    pub label: FreeFormText<PROVIDER_ACCOUNT_LABEL_MAX_LEN>,
}

/// One input slot's feed: the node, its output and which execution of it fed the slot.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowStepSource {
    /// The node that fed the slot.
    pub node_id: WorkflowNodeId,
    /// Which of its outputs.
    pub output_index: SafeInt<0>,
    /// Which execution of it.
    pub execution_index: SafeInt<0>,
}

/// The question a step waiting for a chat reply holds. `questionId` is the record
/// `question.resolve` answers and `waitId` the wait it settles, so the step panel and the session's
/// question card answer one wait and the first answer through either settles both.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowStepQuestion {
    /// The question record.
    pub question_id: QuestionId,
    /// The wait it settles.
    pub wait_id: UuidTextForm,
    /// What it asks.
    pub prompt: ComposedText,
}

/// How a person answered a step that waited on them. `declined` is the `Decline` on a command
/// step's own approval card, which fails that step.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowStepResolutionKind {
    /// Approved.
    Approved,
    /// Rejected.
    Rejected,
    /// Answered.
    Answered,
    /// Declined on a command step's own approval card.
    Declined,
}

/// The record of how a person answered a step and when, kept on the step so the receipt it earns,
/// `Approved at 2:14 PM`, reads the same after a reload.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowStepResolution {
    /// How the person answered.
    pub kind: WorkflowStepResolutionKind,
    /// When.
    #[garde(dive)]
    pub at: WireInstant,
}

/// The snapshot an approval pause took, which Review opens on: pinned to an execution of the run
/// and one of its pauses, or missing with the daemon's words for why it could not be taken.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorkflowStepReviewPause {
    /// Taken.
    Pinned {
        /// Which execution of the run; each re-execution opens the next epoch.
        epoch: WorkflowRunEpoch,
        /// Which of that execution's approval pauses, counted from 1.
        pause_number: WorkflowRunPauseNumber,
    },
    /// Not taken.
    Missing {
        /// Why the snapshot could not be taken; `Open in Review` stays in place saying so.
        reason: ComposedText,
    },
}

/// Declares a struct that leads with the four members that address one step: the run, the node,
/// the attempt and which execution, followed by the struct's own members.
macro_rules! workflow_step_key {
    ($(#[$attribute:meta])+ pub struct $name:ident { $($members:tt)* }) => {
        $(#[$attribute])+
        pub struct $name {
            /// The run.
            pub workflow_run_id: $crate::workflow::run::id::WorkflowRunId,
            /// The node.
            pub node_id: $crate::workflow::definition::document::WorkflowNodeId,
            /// Which attempt at the step, counted from 1: each retry is a new attempt.
            pub attempt: $crate::wire::integer::SafeInt<1>,
            /// Which execution of the node, increasing through the run.
            pub execution_index: $crate::wire::integer::SafeInt<0>,
            $($members)*
        }
    };
}

pub(crate) use workflow_step_key;

workflow_step_key! {
    /// The four members that address one step: the run, the node, the attempt and which
    /// execution. It is the whole input of a form read and a fix session.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct WorkflowStepKey {}
}

/// Declares one shape of [`WorkflowStep`]: the members a step carries whatever its status, then the
/// shape's own.
macro_rules! workflow_step {
    ($($(#[doc = $doc:literal])+ pub struct $name:ident { $($own:tt)* })+) => {$(
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[schemars(inline)]
        #[garde(allow_unvalidated)]
        pub struct $name {
            /// The run.
            pub workflow_run_id: WorkflowRunId,
            /// The node.
            pub node_id: WorkflowNodeId,
            /// Which attempt at the step, counted from 1: each retry is a new attempt.
            pub attempt: SafeInt<1>,
            /// Which execution of the node, increasing through the run, so it orders a branching
            /// run faithfully.
            pub execution_index: SafeInt<0>,
            /// Per input slot, the feed that actually fed it, or `null` for a slot nothing fed.
            pub source: Vec<Option<WorkflowStepSource>>,
            /// When it started.
            #[garde(dive)]
            pub started_at: WireInstant,
            /// When it finished; absent while it has not.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "WireInstant")]
            #[garde(dive)]
            pub finished_at: Option<WireInstant>,
            /// The input it ran on.
            #[garde(dive)]
            pub input_ref: WorkflowPayloadRef,
            /// The output it produced.
            #[garde(dive)]
            pub output_ref: WorkflowPayloadRef,
            /// Its log.
            #[garde(dive)]
            pub log_ref: WorkflowPayloadRef,
            /// What it cost; absent where no provider was billed.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "WorkflowCost")]
            pub cost: Option<WorkflowCost>,
            /// Its error.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "WorkflowStepError")]
            #[garde(dive)]
            pub error: Option<WorkflowStepError>,
            /// Non-fatal hints the step attached; never errors.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "Vec<ComposedText>")]
            pub advisories: Option<Vec<ComposedText>>,
            /// Every field of the agent it ran as actually applied, where it ran one.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "AgentResolvedConfiguration")]
            pub resolved_configuration: Option<AgentResolvedConfiguration>,
            /// Present on an approval step of a run that captured its checkout: its pause's
            /// snapshot.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "WorkflowStepReviewPause")]
            pub review_pause: Option<WorkflowStepReviewPause>,
            /// Present on an `Execute workflow` step once it started its child run, which it links
            /// to.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "WorkflowRunId")]
            pub child_workflow_run_id: Option<WorkflowRunId>,
            $($own)*
        }
    )+};
}

literal! {
    /// The status of a step that waits.
    pub enum WorkflowWaitingStepStatus = "waiting";
    /// The status of a step that failed.
    pub enum WorkflowFailedStepStatus = "failed";
}

/// The status of a step that neither waits nor failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum WorkflowSettledStepStatus {
    /// Not started.
    Pending,
    /// Running.
    Running,
    /// Held by the memory gate before it starts; it needs nobody.
    WaitingMemory,
    /// Done.
    Succeeded,
    /// Passed over by its branch.
    Skipped,
    /// Stopped by its run's end or by a first-to-arrive merge.
    Canceled,
}

impl From<WorkflowSettledStepStatus> for WorkflowStepStatus {
    fn from(status: WorkflowSettledStepStatus) -> Self {
        match status {
            WorkflowSettledStepStatus::Pending => Self::Pending,
            WorkflowSettledStepStatus::Running => Self::Running,
            WorkflowSettledStepStatus::WaitingMemory => Self::WaitingMemory,
            WorkflowSettledStepStatus::Succeeded => Self::Succeeded,
            WorkflowSettledStepStatus::Skipped => Self::Skipped,
            WorkflowSettledStepStatus::Canceled => Self::Canceled,
        }
    }
}

workflow_step! {
    /// A step waiting on a spent provider account: the account and, where armed, the instant the
    /// wait resumes itself.
    pub struct WorkflowAccountWaitingStep {
        /// `waiting`.
        pub status: WorkflowWaitingStepStatus,
        /// The spent account.
        pub wait_account: WorkflowSpentAccount,
        /// When the wait resumes itself; absent where none is armed, when only the person resumes
        /// it.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WireInstant")]
        #[garde(dive)]
        pub resume_at: Option<WireInstant>,
        /// Never present: only a wait on a person gives up.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub wait_deadline_at: Option<Never>,
        /// Never present: only a chat reply holds a question.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub question: Option<Never>,
        /// Never present: a waiting step's process has not ended.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub process_exit: Option<Never>,
        /// Never present: nobody has answered a waiting step.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub resolution: Option<Never>,
    }

    /// A step waiting on a person's chat reply: the question it asked and, where the node sets a
    /// `Timeout`, the instant the wait gives up.
    pub struct WorkflowReplyWaitingStep {
        /// `waiting`.
        pub status: WorkflowWaitingStepStatus,
        /// Never present: only an account wait names an account.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub wait_account: Option<Never>,
        /// Never present: only an account wait resumes itself.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub resume_at: Option<Never>,
        /// When the wait gives up, where the node sets a `Timeout`.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WireInstant")]
        #[garde(dive)]
        pub wait_deadline_at: Option<WireInstant>,
        /// The question the chat reply answers.
        pub question: WorkflowStepQuestion,
        /// Never present: a waiting step's process has not ended.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub process_exit: Option<Never>,
        /// Never present: nobody has answered a waiting step.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub resolution: Option<Never>,
    }

    /// A step waiting on a person's approval or form: where the node sets a `Timeout`, the instant
    /// the wait gives up.
    pub struct WorkflowPersonWaitingStep {
        /// `waiting`.
        pub status: WorkflowWaitingStepStatus,
        /// Never present: only an account wait names an account.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub wait_account: Option<Never>,
        /// Never present: only an account wait resumes itself.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub resume_at: Option<Never>,
        /// When the wait gives up, where the node sets a `Timeout`.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WireInstant")]
        #[garde(dive)]
        pub wait_deadline_at: Option<WireInstant>,
        /// Never present: only a chat reply holds a question.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub question: Option<Never>,
        /// Never present: a waiting step's process has not ended.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub process_exit: Option<Never>,
        /// Never present: nobody has answered a waiting step.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub resolution: Option<Never>,
    }

    /// A step waiting on its chain's question, which carries no instant and no question of its
    /// own.
    pub struct WorkflowChainWaitingStep {
        /// `waiting`.
        pub status: WorkflowWaitingStepStatus,
        /// Never present: only an account wait names an account.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub wait_account: Option<Never>,
        /// Never present: only an account wait resumes itself.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub resume_at: Option<Never>,
        /// Never present: only a wait on a person gives up.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub wait_deadline_at: Option<Never>,
        /// Never present: only a chat reply holds a question.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub question: Option<Never>,
        /// Never present: a waiting step's process has not ended.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub process_exit: Option<Never>,
        /// Never present: nobody has answered a waiting step.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub resolution: Option<Never>,
    }

    /// A failed step: where its process ended on its own, its exit and last lines, and once a
    /// person has answered it, how.
    pub struct WorkflowFailedStep {
        /// `failed`.
        pub status: WorkflowFailedStepStatus,
        /// Never present: only a waiting step names a cause.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub wait_cause: Option<Never>,
        /// Never present: only a waiting step names a spent account.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub wait_account: Option<Never>,
        /// Never present: only a waiting step resumes itself.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub resume_at: Option<Never>,
        /// Never present: only a waiting step gives up.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub wait_deadline_at: Option<Never>,
        /// Never present: only a waiting step holds a question.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub question: Option<Never>,
        /// Present where the step's process ended on its own: its exit and last lines.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "ProcessExit")]
        pub process_exit: Option<ProcessExit>,
        /// Present once a person has answered this step.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WorkflowStepResolution")]
        #[garde(dive)]
        pub resolution: Option<WorkflowStepResolution>,
    }

    /// A step that neither waits nor failed: once a person has answered it, how.
    pub struct WorkflowSettledStep {
        /// Its status.
        pub status: WorkflowSettledStepStatus,
        /// Never present: only a waiting step names a cause.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub wait_cause: Option<Never>,
        /// Never present: only a waiting step names a spent account.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub wait_account: Option<Never>,
        /// Never present: only a waiting step resumes itself.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub resume_at: Option<Never>,
        /// Never present: only a waiting step gives up.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub wait_deadline_at: Option<Never>,
        /// Never present: only a waiting step holds a question.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub question: Option<Never>,
        /// Never present: only a failed step names a process exit.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub process_exit: Option<Never>,
        /// Present once a person has answered this step.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "WorkflowStepResolution")]
        #[garde(dive)]
        pub resolution: Option<WorkflowStepResolution>,
    }
}

/// A waiting step, by what it waits on: a spent account, a person's chat reply, approval or form,
/// or its chain's question.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(tag = "waitCause", rename_all = "snake_case")]
#[schemars(inline)]
pub enum WorkflowWaitingStep {
    /// A spent provider account.
    Account(#[garde(dive)] WorkflowAccountWaitingStep),
    /// A person's chat reply.
    Reply(#[garde(dive)] WorkflowReplyWaitingStep),
    /// A person's approval.
    Approval(#[garde(dive)] WorkflowPersonWaitingStep),
    /// A person's form.
    Form(#[garde(dive)] WorkflowPersonWaitingStep),
    /// The chain's question.
    Chain(#[garde(dive)] WorkflowChainWaitingStep),
}

/// One execution of one node. `executionIndex` is per run and increasing, so it orders a branching
/// run faithfully; `source` records, per input slot, the edge that actually fed it and which
/// execution of the source produced it. Only a waiting step names what it waits on, only a failed
/// one its process exit, and only one no longer waiting how a person answered it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
pub enum WorkflowStep {
    /// Held for a person, a chain's question or a spent account.
    Waiting(#[garde(dive)] WorkflowWaitingStep),
    /// Failed.
    Failed(#[garde(dive)] WorkflowFailedStep),
    /// Any other status.
    Settled(#[garde(dive)] WorkflowSettledStep),
}

/// The TypeScript module of the step record.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/run/step/record",
    doc: "The step record every workflow run method and event shares: one execution of one node, \
          with its payload references, cost, spent account, question, resolution and review pause, \
          and the key that addresses it.",
    definitions: &[
        Definition::read::<WorkflowPayloadRef>().checked(),
        Definition::read::<WorkflowCost>().checked(),
        Definition::read::<WorkflowSpentAccount>().checked(),
        Definition::read::<WorkflowStepSource>(),
        Definition::read::<WorkflowStepQuestion>().checked(),
        Definition::read::<WorkflowStepResolutionKind>(),
        Definition::read::<WorkflowStepResolution>().checked(),
        Definition::read::<WorkflowStepReviewPause>().checked(),
        Definition::read::<WorkflowStepKey>().checked(),
        Definition::read::<WorkflowSettledStepStatus>(),
        Definition::read::<WorkflowStep>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
