//! The daemon's own methods: lifecycle, status, configuration, data, backup, retention,
//! recovery and diagnostics, the status file a failed start leaves, and the answer a mode of the
//! daemon's program writes for the command line.

use crate::typescript::TypeScriptModule;

pub mod app_diagnostic;
pub mod backup;
pub mod config;
pub mod data;
pub mod lifecycle;
pub mod mode_outcome;
pub mod recovery;
pub mod retention;
pub mod service_status;
pub mod status;

/// The topic's TypeScript modules.
pub(crate) const TYPESCRIPT_MODULES: &[&TypeScriptModule] = &[
    &app_diagnostic::TYPESCRIPT_MODULE,
    &backup::TYPESCRIPT_MODULE,
    &config::TYPESCRIPT_MODULE,
    &data::TYPESCRIPT_MODULE,
    &lifecycle::TYPESCRIPT_MODULE,
    &recovery::TYPESCRIPT_MODULE,
    &retention::TYPESCRIPT_MODULE,
    &service_status::TYPESCRIPT_MODULE,
    &status::TYPESCRIPT_MODULE,
];
