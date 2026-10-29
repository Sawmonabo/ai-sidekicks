//! Attention: what needs the person, derived from the sessions' events.
//!
//! An entry is raised, resolved or deleted by the event that announced the change, read from the
//! event's own payload, so a limit's stop and a person's stop part ways; one session-level item is
//! chosen from the run-level items under it.

pub(crate) mod aggregate;
pub mod moment;
