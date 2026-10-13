//! Agents: saved definitions, the live agents of a session, the switch of an agent's provider
//! binding, and the session's agent tree.

use crate::typescript::TypeScriptModule;

pub mod definition;
pub mod methods;
pub mod provider_binding;
pub mod tree;

/// The topic's TypeScript modules.
pub(crate) const TYPESCRIPT_MODULES: &[&TypeScriptModule] = &[
    &definition::TYPESCRIPT_MODULE,
    &methods::TYPESCRIPT_MODULE,
    &provider_binding::TYPESCRIPT_MODULE,
    &tree::TYPESCRIPT_MODULE,
];
