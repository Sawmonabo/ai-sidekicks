//! Attention: what needs the person, derived from the sessions' events.
//!
//! An entry is raised, resolved or deleted by the event that announced the change, read from the
//! event's own payload, so a limit's stop and a person's stop part ways; one session-level item is
//! chosen from the run-level items under it. A pending banner with no app of this machine listening
//! starts the app with no window.

pub(crate) mod aggregate;
pub mod banner_launcher;
pub(crate) mod moment;
pub mod projection;
pub mod rebuild;
pub mod retention;
pub mod schema;
#[cfg(any(test, feature = "test-support"))]
pub mod test_log;
