//! The machine: its id, its registration and its settings file.

use crate::typescript::TypeScriptModule;

pub mod id;
pub mod registration;
pub mod settings;

/// The topic's TypeScript modules.
pub(crate) const TYPESCRIPT_MODULES: &[&TypeScriptModule] = &[
    &id::TYPESCRIPT_MODULE,
    &registration::TYPESCRIPT_MODULE,
    &settings::TYPESCRIPT_MODULE,
];
