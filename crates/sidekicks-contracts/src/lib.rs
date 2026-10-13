//! The wire's one source: serde types with garde checks for every message the daemon, the
//! command line, the desktop and the control plane exchange, from which the TypeScript types and
//! checks are generated.

pub mod agent;
pub mod artifacts;
pub mod daemon;
pub mod event;
pub mod gitflow;
mod internal;
pub mod jsonrpc;
pub mod mcp;
pub mod method;
pub mod preview;
pub mod provider;
pub mod repo;
pub mod run;
pub mod runtime_node;
pub mod schema;
pub mod session;
pub mod transcript;
pub mod typescript;
pub mod wire;
pub mod workflow;
pub mod worktree;

use crate::typescript::TypeScriptModule;

/// Every contract module's TypeScript face, topic by topic: what the emit writes for the
/// TypeScript generator.
pub fn typescript_modules() -> impl Iterator<Item = &'static TypeScriptModule> {
    [
        event::TYPESCRIPT_MODULES,
        internal::TYPESCRIPT_MODULES,
        jsonrpc::TYPESCRIPT_MODULES,
        run::TYPESCRIPT_MODULES,
        wire::TYPESCRIPT_MODULES,
        workflow::TYPESCRIPT_MODULES,
    ]
    .into_iter()
    .flatten()
    .copied()
}
