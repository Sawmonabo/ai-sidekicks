//! Workflows: definitions, node kinds, runs, secrets and subscriptions.

use crate::typescript::TypeScriptModule;

pub mod run;

/// The topic's TypeScript modules.
pub(crate) const TYPESCRIPT_MODULES: &[&TypeScriptModule] = run::TYPESCRIPT_MODULES;
