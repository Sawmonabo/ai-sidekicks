//! Each session's inbox, which the Claude Code driver binds for the session's whole life under the
//! name Claude Code answers: where it lives, the listener that holds it across a sleep, and the
//! forwarder that passes each connection's frames to the live process.

pub(crate) mod address;
pub(super) mod forward;
pub(super) mod listener;
