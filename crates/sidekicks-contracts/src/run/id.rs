//! The id of one run, which every run, session, approval, question, plan and workflow contract
//! carries.

use crate::internal::branded::branded_uuid_id;
use crate::typescript::{Definition, TypeScriptModule};

branded_uuid_id! {
    /// Identifies one run. Only a UUID is accepted, so a path or an SQL fragment never reaches a
    /// store lookup.
    RunId
}

/// The TypeScript module of a run's id.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "run/id",
    doc: "The id of one run, which every run, session, approval, question, plan and workflow \
          contract carries.",
    definitions: &[Definition::read::<RunId>().checked()],
    constants: &[],
    method_tables: &[],
};
