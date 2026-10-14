//! The hold on starting new runs: one per daemon over its whole scheduler, and how many starts wait
//! behind it.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::integer::SafeInt;

/// The `workflow.runsPauseSet` input: the hold on starting new runs, one per daemon over its whole
/// scheduler. A run already going finishes; every new start waits until the hold is off.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowRunsPauseSetRequest {
    /// Whether the hold is on.
    pub paused: bool,
}

/// The hold and how many starts wait behind it, as the `workflow.runsPauseSet` reply and the
/// `workflow.subscribe` stream carry it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRunsPauseState {
    /// Whether the hold is on.
    pub paused: bool,
    /// How many starts wait behind it.
    pub waiting_start_count: SafeInt<0>,
}

/// The TypeScript module of the hold on starting new runs.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/run/pause",
    doc: "The hold on starting new runs: one per daemon over its whole scheduler, and how many \
          starts wait behind it.",
    definitions: &[
        Definition::read::<WorkflowRunsPauseSetRequest>().checked(),
        Definition::read::<WorkflowRunsPauseState>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
