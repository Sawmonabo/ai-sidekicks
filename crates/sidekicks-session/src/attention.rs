//! Attention: what needs the person, derived from the sessions' events.
//!
//! An entry is raised, resolved or deleted by the event that announced the change, read from the
//! event's own payload, so a limit's stop and a person's stop part ways; one session-level item is
//! chosen from the run-level items under it. Each entry's banner and web-address message are
//! decided once, after a half-second merge per subject, and a pending banner with no app of this
//! machine listening starts the app with no window. A provider's new build is listed from the
//! record of each provider's builds, under no session and on no channel.

pub(crate) mod aggregate;
pub mod banner_launcher;
pub mod changes;
pub mod delivery;
pub(crate) mod gate;
pub(crate) mod moment;
pub mod projection;
pub(crate) mod provider_build;
pub mod read;
pub mod rebuild;
pub mod retention;
pub mod schema;
pub mod seen;
pub mod service;
#[cfg(any(test, feature = "test-support"))]
pub mod test_log;
