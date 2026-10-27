//! The daemon: one program that runs sessions with each provider's agent, their git worktrees,
//! terminals and the SQLite store, and the helper modes it starts by name.

pub mod admission;
pub mod artifacts;
pub mod bootstrap;
pub mod daemon;
pub(crate) mod data_acts;
pub mod highlight;
pub mod ipc;
pub mod observability;
pub mod orchestration;
pub mod plans;
pub mod program;
pub mod queue;
pub mod recovery;
pub mod remote;
