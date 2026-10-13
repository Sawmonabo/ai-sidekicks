//! Workflow runs: their ids, statuses, snapshots, control, records and steps.

use crate::typescript::TypeScriptModule;

pub mod failures;
pub mod snapshot;
pub mod status;

/// The workflow runs' TypeScript modules.
pub(crate) const TYPESCRIPT_MODULES: &[&TypeScriptModule] = &[
    &failures::TYPESCRIPT_MODULE,
    &snapshot::TYPESCRIPT_MODULE,
    &status::TYPESCRIPT_MODULE,
];
