//! Run retention: deleting one run, deleting the runs older than an instant and its preview, and
//! marking a run Keep, which such a delete leaves.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::True;
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::workflow::run::id::WorkflowRunId;

/// The `workflow.runDelete` input. Deleting a run removes its record, its steps and its recorded
/// snapshots, and cannot be undone; a run that has not ended is refused: cancel it first.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowRunDeleteRequest {
    /// The run.
    pub workflow_run_id: WorkflowRunId,
}

/// The `workflow.runDelete` result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRunDeleteResponse {
    /// The run.
    pub workflow_run_id: WorkflowRunId,
    /// Always `true`.
    pub deleted: True,
}

/// The `workflow.runsDeletePreview` and `workflow.runsDelete` input: the runs that started before
/// this instant. A run marked Keep, one that has not ended, and a chain's first run while a later
/// run of its chain has not ended are never removed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowRunsDeleteRequest {
    /// The instant.
    #[garde(dive)]
    pub older_than: WireInstant,
}

/// The `workflow.runsDeletePreview` result, read before the confirm: how many runs the delete would
/// remove, and how many older runs it would leave because they are kept or waiting.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRunsDeletePreviewResponse {
    /// The runs it would remove.
    pub delete_count: SafeInt<0>,
    /// The older runs it would leave because they are marked Keep.
    pub kept_count: SafeInt<0>,
    /// The older runs it would leave because they are waiting.
    pub waiting_count: SafeInt<0>,
}

/// The `workflow.runsDelete` result. Runs may start or end between the preview and the delete, so
/// this count, not the preview's, is what was removed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRunsDeleteResponse {
    /// The runs removed.
    pub deleted_count: SafeInt<0>,
}

/// The `workflow.runKeepSet` input and result alike: whether the run is marked Keep, which deleting
/// old runs leaves.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowRunKeepSet {
    /// The run.
    pub workflow_run_id: WorkflowRunId,
    /// Whether it is marked Keep.
    pub keep: bool,
}

/// The TypeScript module of run retention.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/run/retention",
    doc: "Run retention: deleting one run, deleting the runs older than an instant and its \
          preview, and marking a run Keep, which such a delete leaves.",
    definitions: &[
        Definition::read::<WorkflowRunDeleteRequest>().checked(),
        Definition::read::<WorkflowRunDeleteResponse>().checked(),
        Definition::read::<WorkflowRunsDeleteRequest>().checked(),
        Definition::read::<WorkflowRunsDeletePreviewResponse>().checked(),
        Definition::read::<WorkflowRunsDeleteResponse>().checked(),
        Definition::read::<WorkflowRunKeepSet>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
