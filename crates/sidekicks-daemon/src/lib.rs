//! The daemon: one program that runs sessions with each provider's agent, their git worktrees,
//! terminals and the SQLite store, and the helper modes it starts by name.

pub(crate) mod bootstrap;
pub(crate) mod control_plane_credential;
pub mod daemon;
pub(crate) mod data_acts;
pub(crate) mod highlight;
pub(crate) mod ipc;
pub(crate) mod observability;
pub(crate) mod orchestration;
pub mod program;
pub(crate) mod remote;
