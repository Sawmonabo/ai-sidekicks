//! The refusal every run method shares and the codes a failed step carries, each with the details
//! that ride the failed step's error and its failed event.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::VariantArray;

use crate::jsonrpc::refusal::RefusalCode;
use crate::provider::id::ProviderId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::integer::SafeInt;
use crate::wire::text::ComposedText;

/// Which limit cut a step.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowStepTimedOutCause {
    /// The step's own `Timeout`.
    StepTimeout,
    /// The run's cap.
    RunCap,
}

/// The time-limit failure's details: which limit, and the limit itself in milliseconds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowStepTimedOutDetails {
    /// Which limit cut the step.
    pub cause: WorkflowStepTimedOutCause,
    /// The limit, in milliseconds.
    pub limit_ms: SafeInt<1>,
}

/// Why a quick step's engine failed: it could not be started.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowStepThreadFailedReason {
    /// The step's thread, `rquickjs` runtime or context could not be created.
    StartFailed,
}

/// The engine failure's details: why the engine failed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowStepThreadFailedDetails {
    /// Why the engine failed.
    pub reason: WorkflowStepThreadFailedReason,
}

/// Why a full-tier Code step's package install failed: too little disk to hold it, or any other
/// install error, a stale lock included.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowCodeInstallFailedReason {
    /// Too little disk to hold the install.
    DiskSpace,
    /// Any other install error, a stale lock included.
    ToolError,
}

/// The sandbox failure's details: whose sandbox, and its wrapper's own error.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowSandboxUnavailableDetails {
    /// The provider whose sandbox did not start.
    pub provider: ProviderId,
    /// The sandbox wrapper's own error.
    pub detail: ComposedText,
}

/// The install failure's details: the reason and the installer's own error.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowCodeInstallFailedDetails {
    /// Why the install failed.
    pub reason: WorkflowCodeInstallFailedReason,
    /// The installer's own error.
    pub detail: ComposedText,
}

ts_constants! {
    /// A workflow definition or run that does not exist.
    WORKFLOW_NOT_FOUND_CODE = RefusalCode::WorkflowNotFound;
    /// A step cut by a time limit: its own `Timeout`, or the run's cap.
    WORKFLOW_STEP_TIMED_OUT_CODE = RefusalCode::WorkflowStepTimedOut;
    /// Every limit that cuts a step.
    WORKFLOW_STEP_TIMED_OUT_CAUSES = WorkflowStepTimedOutCause::VARIANTS;
    /// A quick step's engine that could not be started.
    WORKFLOW_STEP_THREAD_FAILED_CODE = RefusalCode::WorkflowStepThreadFailed;
    /// Every reason a quick step's engine fails.
    WORKFLOW_STEP_THREAD_FAILED_REASONS = WorkflowStepThreadFailedReason::VARIANTS;
    /// A full-tier Code step or a sandboxed shell step whose provider sandbox did not start; the
    /// step never runs unprotected instead.
    WORKFLOW_SANDBOX_UNAVAILABLE_CODE = RefusalCode::WorkflowSandboxUnavailable;
    /// A full-tier Code step whose package install did not finish.
    WORKFLOW_CODE_INSTALL_FAILED_CODE = RefusalCode::WorkflowCodeInstallFailed;
    /// Every reason a package install fails.
    WORKFLOW_CODE_INSTALL_FAILED_REASONS = WorkflowCodeInstallFailedReason::VARIANTS;
    /// A Code step over its memory budget; a deadline cut is `workflow.step_timed_out` instead.
    WORKFLOW_CODE_OVER_BUDGET_CODE = RefusalCode::WorkflowCodeOverBudget;
}

/// The TypeScript module of the run refusal and the step failures.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/run/failures",
    doc: "The refusal every run method shares and the codes a failed step carries, each with the \
          details that ride the failed step's error and its failed event.",
    definitions: &[
        Definition::read::<WorkflowStepTimedOutCause>(),
        Definition::read::<WorkflowStepTimedOutDetails>(),
        Definition::read::<WorkflowStepThreadFailedReason>(),
        Definition::read::<WorkflowStepThreadFailedDetails>(),
        Definition::read::<WorkflowSandboxUnavailableDetails>(),
        Definition::read::<WorkflowCodeInstallFailedReason>(),
        Definition::read::<WorkflowCodeInstallFailedDetails>(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
