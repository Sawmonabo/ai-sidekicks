//! The envelope version of the session events the daemon writes itself.

use std::sync::LazyLock;

use sidekicks_contracts::event::version::EventEnvelopeVersion;

/// The envelope version of a session's lifecycle and directory events, its runs' and its run
/// queue's events, its shells' changes of holder, its purge receipts, its workspace and worktree
/// events and a workflow run's delete.
pub static SESSION_EVENT_VERSION: LazyLock<EventEnvelopeVersion> = LazyLock::new(|| {
    EventEnvelopeVersion::new("1.0".to_owned()).expect("\"1.0\" is a MAJOR.MINOR version")
});
