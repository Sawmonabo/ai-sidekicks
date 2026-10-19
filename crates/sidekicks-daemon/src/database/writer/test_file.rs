//! A database file for tests, opened as the daemon opens its own with the daemon's whole schema,
//! and the event rows tests write to it.

use std::path::PathBuf;

use rusqlite::Connection;
use tempfile::TempDir;

use crate::cleanup_failures::CleanupFailures;
use crate::database::connection::writer_open::{DatabaseOpenError, open_database};

// The event rows serve only the crate's own tests.
#[cfg(test)]
use std::sync::Arc;

#[cfg(test)]
use serde_json::json;
#[cfg(test)]
use sidekicks_contracts::event::envelope::EventOccurredAt;
#[cfg(test)]
use sidekicks_contracts::event::session::SessionEvent;
#[cfg(test)]
use sidekicks_contracts::session::id::SessionId;

#[cfg(test)]
use crate::events::session::appender::{SessionEventDraft, UnsequencedEventEnvelope};
#[cfg(test)]
use crate::events::session::insert::{SessionEventRow, monotonic_ns_now};
#[cfg(test)]
use crate::events::session::version::SESSION_EVENT_VERSION;
#[cfg(test)]
use crate::uuid_v7::mint_uuid_v7;

/// A database file in a folder of its own, removed when this drops.
pub struct TestDatabase {
    folder: TempDir,
}

impl TestDatabase {
    /// A folder for a database file the opener creates.
    pub fn new() -> Self {
        Self {
            folder: tempfile::tempdir().expect("the test makes a temporary folder"),
        }
    }

    /// The database file's path.
    pub fn path(&self) -> PathBuf {
        self.folder.path().join("daemon.db")
    }

    /// The opener a writer runs on its thread: the daemon's own open of the file, which creates it
    /// with the daemon's schema. Fails as that open does.
    pub fn opener(
        &self,
    ) -> impl FnOnce() -> Result<Connection, CleanupFailures<DatabaseOpenError, rusqlite::Error>>
    + Send
    + 'static {
        let path = self.path();
        move || open_database(&path)
    }

    /// A second connection on the file, for a test to read what the writer committed.
    pub fn reader(&self) -> Connection {
        Connection::open(self.path()).expect("the test opens a second connection on its file")
    }
}

/// A fresh session's id.
#[cfg(test)]
pub(crate) fn test_session_id() -> SessionId {
    SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id")
}

/// The envelope of `event` on `session_id`'s log, occurring now, with no linkage.
#[cfg(test)]
pub(crate) fn test_envelope(
    session_id: SessionId,
    event: &SessionEvent,
) -> UnsequencedEventEnvelope {
    UnsequencedEventEnvelope::new(
        SessionEventDraft::of_session(session_id, event)
            .expect("the test's event passes its checks"),
        EventOccurredAt::now(),
        None,
        None,
        SESSION_EVENT_VERSION.clone(),
    )
}

/// A `session.pinned` row for `session_id`, with no body.
#[cfg(test)]
pub(crate) fn session_event_row(session_id: &SessionId) -> SessionEventRow {
    let pinned = serde_json::from_value(json!({
        "type": "session.pinned",
        "payload": { "sessionId": session_id, "at": "2026-10-14T09:00:00.000Z" },
    }))
    .expect("the test writes a session.pinned event");
    let envelope = test_envelope(*session_id, &pinned);
    SessionEventRow {
        payload: serde_json::to_string(envelope.payload()).expect("a JSON object serializes"),
        envelope: Arc::new(envelope),
        monotonic_ns: monotonic_ns_now(),
        content_payload: None,
    }
}
