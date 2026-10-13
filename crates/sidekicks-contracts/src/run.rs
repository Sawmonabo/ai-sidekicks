//! Runs: ids, state, the queue, control, events, children, subagents and failure causes.

use crate::typescript::TypeScriptModule;

pub mod state;

/// The topic's TypeScript modules.
pub(crate) const TYPESCRIPT_MODULES: &[&TypeScriptModule] = &[&state::TYPESCRIPT_MODULE];
