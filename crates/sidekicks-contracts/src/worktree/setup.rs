//! Setting a new tree up, as the composer's setup card follows it: making the tree, the project's
//! own setup steps, and warming what the session reads first. The steps are kept, so the card
//! reads the same after leaving the session and coming back; a failed step stops the run and the
//! card stays until it is retried from that step.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::project::PROJECT_SETUP_COMMAND_MAX_LEN;
use crate::repo::workspace::WORKSPACE_LAST_ERROR_MAX_LEN;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::integer::SafeInt;
use crate::wire::text::FreeFormText;
use crate::worktree::lifecycle::WorktreeId;

ts_constants! {
    /// The longest captured output a setup step carries; the daemon keeps the tail of a longer
    /// output, cut to this many code points.
    pub const WORKTREE_SETUP_OUTPUT_MAX_LEN: usize = 32768;
}

/// The stages of setting a tree up, in the order they run.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum WorktreeSetupStage {
    /// Making the tree.
    MakeTree,
    /// The project's own setup steps.
    ProjectSteps,
    /// Warming what the session reads first.
    WarmCaches,
}

/// Where one setup step stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum WorktreeSetupStepState {
    /// Not run yet.
    Pending,
    /// Running.
    Running,
    /// Succeeded.
    Succeeded,
    /// Failed.
    Failed,
}

/// Where a tree's setup card stands; `notRun`, with no steps, is a tree with no card to show: its
/// setup did not run since the daemon started, or it has none.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum WorktreeSetupState {
    /// Running.
    Running,
    /// Succeeded.
    Succeeded,
    /// A step failed.
    Failed,
    /// No card to show.
    NotRun,
}

/// One step of the setup card, in run order. `error` and `output` are present on a failed step,
/// and `elapsedMs` once the step has run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorktreeSetupStep {
    /// Its stage.
    pub stage: WorktreeSetupStage,
    /// What it is: the command, for a project step.
    pub label: FreeFormText<PROJECT_SETUP_COMMAND_MAX_LEN>,
    /// Where it stands.
    pub state: WorktreeSetupStepState,
    /// How long it ran, in milliseconds.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<0>")]
    pub elapsed_ms: Option<SafeInt<0>>,
    /// Why it failed.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<WORKSPACE_LAST_ERROR_MAX_LEN>")]
    pub error: Option<FreeFormText<WORKSPACE_LAST_ERROR_MAX_LEN>>,
    /// Its captured output.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<WORKTREE_SETUP_OUTPUT_MAX_LEN>")]
    pub output: Option<FreeFormText<WORKTREE_SETUP_OUTPUT_MAX_LEN>>,
}

/// One `worktree.setup.subscribe` emission: the whole card for one tree.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorktreeSetupStatus {
    /// The tree.
    pub worktree_id: WorktreeId,
    /// Where the card stands.
    pub state: WorktreeSetupState,
    /// Its steps.
    pub steps: Vec<WorktreeSetupStep>,
}

/// `worktree.setup.subscribe` and `worktree.setup.retry`: the tree whose setup a card follows
/// or retries. A retry runs the failed step and the ones after it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorktreeSetupRequest {
    /// The tree.
    pub worktree_id: WorktreeId,
}

/// The TypeScript module of a new tree's setup.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "worktree/setup",
    doc: "Setting a new tree up, as the composer's setup card follows it, and its retry.",
    definitions: &[
        Definition::read::<WorktreeSetupStage>(),
        Definition::read::<WorktreeSetupStepState>(),
        Definition::read::<WorktreeSetupState>(),
        Definition::read::<WorktreeSetupStep>(),
        Definition::read::<WorktreeSetupStatus>(),
        Definition::read::<WorktreeSetupRequest>(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
