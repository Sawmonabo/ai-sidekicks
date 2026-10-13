//! The id of one workflow run, which every run method, event and step record carries.

use crate::internal::branded::branded_uuid_id;
use crate::typescript::{Definition, TypeScriptModule};

branded_uuid_id! {
    /// Identifies one workflow run: a UUID the daemon mints; a client never builds one.
    WorkflowRunId
}

/// The TypeScript module of a workflow run's id.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/run/id",
    doc: "The id of one workflow run, which every run method, event and step record carries.",
    definitions: &[Definition::read::<WorkflowRunId>().checked()],
    constants: &[],
    method_tables: &[],
};
