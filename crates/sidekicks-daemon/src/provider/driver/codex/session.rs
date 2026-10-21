//! A Codex session's own pieces: its state and inbound queue, its errors, its `agentConfig`, its
//! helper role files, where it runs, its history readers, its background terminals and the
//! release of a conversation it moved off.

pub(super) mod background_terminals;
pub(super) mod config;
pub(super) mod conversation_release;
pub(super) mod errors;
pub(super) mod helper_roles;
pub(super) mod history;
pub(super) mod inbound;
pub(super) mod spawn_context;
pub(super) mod state;
