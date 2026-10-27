//! The inputs of the workflow tools an agent calls from a session, for the tools whose input
//! differs from the request of the method they drive. `workflow_run`'s input is the contracts'
//! `workflow::run::tool`, which the desktop also reads; `workflow_kinds`, `workflow_list`,
//! `workflow_create`, `workflow_update` and `workflow_enable` take their methods' requests
//! (`workflow.kind.list`, `workflow.definition.list`, `workflow.definition.create`,
//! `workflow.definition.update`, `workflow.enabled.update`) unchanged.
//!
//! No tool takes a session id: the session is the one whose turn made the call, so an agent cannot
//! reach another session. The JSON Schema a provider receives is generated from these types, so
//! each member's description is the text the model reads.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowDefinitionId, WorkflowDraftDocument,
};

/// The `workflow_read` input: one version of a workflow, and with `diffFromVersion` its changes
/// since that version. It drives the definition read, the version read and the version diff, each
/// addressed by version number.
#[expect(
    dead_code,
    reason = "the workflow agent tools read an agent's workflow_read call into it"
)]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub(crate) struct WorkflowReadToolInput {
    /// The workflow.
    #[schemars(description = "The workflow's id, from workflow_list.")]
    pub(crate) definition_id: WorkflowDefinitionId,
    /// The version read; the latest when absent.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(
        with = "SafeInt<1>",
        description = "The version number. Omitted, the latest."
    )]
    pub(crate) version: Option<SafeInt<1>>,
    /// The earlier version the result names the changes since.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "sidekicks_contracts::wire::present"
    )]
    #[schemars(
        with = "SafeInt<1>",
        description = "An earlier version number; the result adds what changed since it."
    )]
    pub(crate) diff_from_version: Option<SafeInt<1>>,
}

/// The `workflow_validate` input: a document checked as a save would check it, unsaved.
#[expect(
    dead_code,
    reason = "the workflow agent tools read an agent's workflow_validate call into it"
)]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkflowValidateToolInput {
    /// The document to check.
    #[schemars(
        description = "The document to check. The result lists every finding a save would refuse."
    )]
    #[garde(dive)]
    pub(crate) document: WorkflowDraftDocument,
}

/// The `workflow_schedule_set` input: a new schedule for a workflow's schedule trigger. The tool
/// reads the workflow and saves a new version, so it names the version it read and is refused when
/// another save came first.
#[expect(
    dead_code,
    reason = "the workflow agent tools read an agent's workflow_schedule_set call into it"
)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub(crate) struct WorkflowScheduleSetToolInput {
    /// The workflow.
    #[schemars(description = "The workflow's id, from workflow_list.")]
    pub(crate) definition_id: WorkflowDefinitionId,
    /// The version the change was made over.
    #[schemars(
        description = "The version number read before this change; refused if a newer version \
                       exists."
    )]
    pub(crate) expected_version_number: SafeInt<1>,
    /// The cron expression.
    #[schemars(description = "A cron expression, such as 0 8 * * 1-5.")]
    pub(crate) expression: NonEmptyText,
    /// The time zone the expression is read in.
    #[schemars(
        description = "The IANA time zone the expression is read in, such as America/New_York."
    )]
    pub(crate) time_zone: NonEmptyText,
}
