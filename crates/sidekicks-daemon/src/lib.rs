//! The daemon: one program that runs sessions with Claude Code and Codex, their git worktrees,
//! terminals and the SQLite store, and the helper modes it starts by name.

pub mod admission;
pub mod approvals;
pub mod artifacts;
pub mod attention;
pub mod bootstrap;
pub mod daemon;
pub mod database;
pub mod disk_flush;
pub mod events;
pub mod file;
pub mod git;
pub mod highlight;
pub mod interventions;
pub mod ipc;
pub mod mcp;
pub mod observability;
pub mod operating_system;
pub mod orchestration;
pub mod path_rules;
pub mod policy;
pub mod process_tree;
pub mod provider;
pub mod pty;
pub mod queue;
pub mod recovery;
pub mod session;
pub mod transcript;
pub mod worker;
pub mod workflow;
pub mod workspace;
