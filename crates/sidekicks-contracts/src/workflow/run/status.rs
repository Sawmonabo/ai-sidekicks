//! The statuses every workflow run method and event shares: the run's, each step's, and what a
//! waiting step waits on.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::{IntoStaticStr, VariantArray};

use crate::typescript::{Definition, TypeScriptModule, ts_constants};

/// A run's status; no screen shows any other. `waiting` covers a run held by a person, a chain's
/// question or a spent provider account; it is never swept to `crashed` when the daemon starts and
/// never pruned, so a waiting run survives a restart.
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
pub enum WorkflowRunStatus {
    /// Started, with no step run yet.
    New,
    /// A step is running.
    Running,
    /// Held by a person, a chain's question or a spent provider account.
    Waiting,
    /// Ended with every step done.
    Succeeded,
    /// Ended by a step's failure.
    Failed,
    /// Ended by a cancel.
    Canceled,
    /// Ended because the daemon stopped while it ran.
    Crashed,
}

/// The status of one step, meaning one execution of one node. `waiting` is a step held for a
/// person, a chain's question or a spent account; `waitingMemory` is a step the memory gate has
/// not started yet, which needs nobody. `canceled` is a step that was running or waiting when its
/// run ended failed or canceled, or a branch a first-to-arrive merge stopped.
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
pub enum WorkflowStepStatus {
    /// Not started.
    Pending,
    /// Running.
    Running,
    /// Held for a person, a chain's question or a spent account.
    Waiting,
    /// Held by the memory gate before it starts.
    WaitingMemory,
    /// Done.
    Succeeded,
    /// Failed.
    Failed,
    /// Passed over by its branch.
    Skipped,
    /// Stopped by its run's end or by a first-to-arrive merge.
    Canceled,
}

/// What a waiting step waits on: a person's approval, form or chat reply, its chain's question, or
/// a spent provider account. Only the account wait needs nobody.
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
pub enum WorkflowWaitCause {
    /// A person's approval.
    Approval,
    /// A person's form.
    Form,
    /// A person's chat reply.
    Reply,
    /// A spent provider account.
    Account,
    /// The chain's question.
    Chain,
}

ts_constants! {
    /// Every run status, in the order a screen lists them.
    WORKFLOW_RUN_STATUSES = WorkflowRunStatus::VARIANTS;
    /// The statuses of a run that is still going: new, running or waiting.
    pub const GOING_RUN_STATUSES: [WorkflowRunStatus; 3] = [
        WorkflowRunStatus::New,
        WorkflowRunStatus::Running,
        WorkflowRunStatus::Waiting,
    ];
    /// Every step status.
    WORKFLOW_STEP_STATUSES = WorkflowStepStatus::VARIANTS;
    /// Every wait cause.
    WORKFLOW_WAIT_CAUSES = WorkflowWaitCause::VARIANTS;
}

/// The TypeScript module of the workflow statuses.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/run/status",
    doc: "The statuses every workflow run method and event shares: the run's, each step's, and \
          what a waiting step waits on.",
    definitions: &[
        Definition::read::<WorkflowRunStatus>().checked(),
        Definition::read::<WorkflowStepStatus>(),
        Definition::read::<WorkflowWaitCause>(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
