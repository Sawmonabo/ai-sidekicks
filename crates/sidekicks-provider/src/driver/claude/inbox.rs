//! Each session's inbox, which the Claude Code driver binds for the session's whole life under the
//! name Claude Code answers: where it lives, the listener that holds it across a sleep, the
//! forwarder that passes each connection's frames to the live process, the writer of a message
//! the daemon delivers into a session, the words a wait held on that delivery's answer reads, and
//! the reader of the receipts and replies Claude Code writes back to the daemon's own inbox.

pub(crate) mod address;
pub(super) mod deliver;
pub(super) mod forward;
pub(super) mod held_wait;
pub(super) mod listener;
pub(super) mod receipts;
