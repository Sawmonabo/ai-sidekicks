//! Runtime nodes: a machine's id and registration.

use crate::typescript::TypeScriptModule;

pub mod id;
pub mod registration;

/// The topic's TypeScript modules.
pub(crate) const TYPESCRIPT_MODULES: &[&TypeScriptModule] =
    &[&id::TYPESCRIPT_MODULE, &registration::TYPESCRIPT_MODULE];
