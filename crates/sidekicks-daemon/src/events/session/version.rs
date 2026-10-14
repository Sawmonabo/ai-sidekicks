//! The envelope version of the session events the daemon writes outside a run.

use std::sync::LazyLock;

use sidekicks_contracts::event::version::EventEnvelopeVersion;

/// The envelope version of a session's lifecycle and directory events, its shells' changes of
/// holder and its purge receipts.
pub(crate) static SESSION_EVENT_VERSION: LazyLock<EventEnvelopeVersion> = LazyLock::new(|| {
    EventEnvelopeVersion::new("1.0".to_owned()).expect("\"1.0\" is a MAJOR.MINOR version")
});
