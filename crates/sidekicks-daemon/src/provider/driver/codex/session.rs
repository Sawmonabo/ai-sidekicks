//! A Codex session's own pieces: its state and inbound queue, the calls run on its record, its
//! errors, its helper role files, where it runs, its history readers, its background terminals,
//! its forks and the controls Codex carries on its conversation, the release of a conversation it
//! moved off, the purge of its conversations, its side questions, and the slots its transitions
//! are claimed in.

pub(super) mod background_terminals;
pub(super) mod calls;
pub(super) mod controls;
pub(super) mod conversation_release;
pub(super) mod errors;
pub(super) mod fork;
pub(super) mod helper_roles;
pub(super) mod history;
pub(super) mod inbound;
pub(super) mod purge;
pub(super) mod side_questions;
pub(super) mod slots;
pub(super) mod state;
#[cfg(test)]
pub(super) mod test_session;
