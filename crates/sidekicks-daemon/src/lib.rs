//! The daemon: one program that runs sessions with each provider's agent, their git worktrees,
//! terminals and the SQLite store, and the helper modes it starts by name.

pub mod admission;
pub mod approvals;
pub mod artifacts;
pub(crate) mod askpass_prompt;
pub mod attention;
pub mod bootstrap;
pub mod crash_window;
pub mod daemon;
pub(crate) mod data_acts;
pub(crate) mod file_watch;
pub mod git;
pub mod highlight;
pub mod interventions;
pub mod ipc;
pub mod mcp;
pub mod observability;
pub mod orchestration;
pub mod plans;
pub mod policy;
pub mod program;
pub mod provider;
pub mod pty;
pub mod questions;
pub mod queue;
pub mod recovery;
pub(crate) mod redaction;
pub mod remote;
pub mod session;
pub mod transcript;
pub mod workflow;
pub mod workspace;
