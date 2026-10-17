//! Git: local branch work and the git host's pull requests.

use crate::typescript::TypeScriptModule;

pub mod hosting;
pub mod local;
pub mod methods;
pub mod shared;

/// The topic's TypeScript modules.
pub(crate) const TYPESCRIPT_MODULES: &[&TypeScriptModule] = &[
    &hosting::TYPESCRIPT_MODULE,
    &local::TYPESCRIPT_MODULE,
    &methods::TYPESCRIPT_MODULE,
    &shared::TYPESCRIPT_MODULE,
];
