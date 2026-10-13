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
pub mod preview;
pub mod provider;
pub mod repo;
pub mod run;
pub mod runtime_node;
pub mod session;
pub mod transcript;
pub mod workflow;
pub mod worktree;
