//! How the Claude Code driver starts a Claude Code process: its command line, environment,
//! settings and legs, the account home it runs on, and the launcher every process starts through.

pub(super) mod account_home;
pub(super) mod arguments;
pub(super) mod environment;
pub(super) mod launch;
pub(super) mod legs;
pub(super) mod settings;
