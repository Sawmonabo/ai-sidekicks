//! A workflow's kept values: what `Keep for later runs` holds for the workflow's later runs, and
//! clearing them, with its method table.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::method::methods;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::integer::SafeInt;
use crate::workflow::definition::document::WorkflowDefinitionId;

/// The `workflow.keptVarsClear` input: clear every value `Keep for later runs` kept for one
/// workflow. Kept values belong to the workflow, not to a version.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowKeptVarsClearRequest {
    /// The workflow.
    pub definition_id: WorkflowDefinitionId,
}

/// The `workflow.keptVarsClear` result: how many kept values went.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowKeptVarsClearResponse {
    /// The workflow.
    pub definition_id: WorkflowDefinitionId,
    /// How many kept values were cleared.
    pub cleared_count: SafeInt<0>,
}

methods! {
    /// The `workflow.keptVarsClear` method's table.
    pub const WORKFLOW_KEPT_VARS_METHOD_DESCRIPTORS = [
        /// Clears the values one workflow's runs kept for later runs.
        WorkflowKeptVarsClear = mutation "workflow.keptVarsClear" {
            mutating: true,
            params: WorkflowKeptVarsClearRequest,
            result: WorkflowKeptVarsClearResponse,
            refusals: [WorkflowNotFound],
        },
    ];
}

/// The TypeScript module of a workflow's kept values.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/kept-vars",
    doc: "A workflow's kept values: what `Keep for later runs` holds for the workflow's later \
          runs, and clearing them, with its method table.",
    definitions: &[
        Definition::read::<WorkflowKeptVarsClearRequest>().checked(),
        Definition::read::<WorkflowKeptVarsClearResponse>().checked(),
    ],
    constants: &[],
    method_tables: &[&WORKFLOW_KEPT_VARS_METHOD_DESCRIPTORS],
};
