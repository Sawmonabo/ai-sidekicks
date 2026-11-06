//! How the Claude Code driver starts a Claude Code process: its command line, environment,
//! settings and legs, the account home it runs on, and the launcher every process starts through.

pub(super) mod account_home;
pub(super) mod arguments;
pub(super) mod command;
pub(super) mod environment;
pub(super) mod launch;
pub(super) mod legs;
pub(crate) mod one_shot_command;
pub(super) mod settings;
pub(super) mod system_prompt;
