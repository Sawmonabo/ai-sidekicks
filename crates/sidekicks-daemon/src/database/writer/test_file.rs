//! A database file for tests, opened as the daemon opens its own with the daemon's whole schema,
//! and the event rows tests write to it.

// The event rows' imports are gated: those rows serve only the crate's own tests.
use std::path::PathBuf;
#[cfg(test)]
use std::sync::Arc;

use rusqlite::Connection;
use tempfile::TempDir;
#[cfg(test)]
use {
    serde_json::json,
    sidekicks_contracts::{
        event::envelope::EventOccurredAt, event::session::SessionEvent, run::id::RunId,
        session::id::SessionId, wire::integer::SafeInt,
    },
};

use crate::cleanup_failures::CleanupFailures;
use crate::database::connection::writer_open::{DatabaseOpenError, open_database};
#[cfg(test)]
use crate::{
    events::content::codec::BodyEncoder,
    events::log_service::compose_rows,
    events::session::appender::{SessionEventDraft, UnsequencedEventEnvelope},
    events::session::insert::{SessionEventRow, insert_session_event, monotonic_ns_now},
    events::session::version::SESSION_EVENT_VERSION,
};
#[cfg(test)]
use sidekicks_contracts::wire::id::mint_uuid_v7;

/// A database file in a folder of its own, removed when this drops.
pub struct TestDatabase {
    folder: TempDir,
}

impl TestDatabase {
    /// A folder for a database file the opener creates.
    #[expect(
        clippy::new_without_default,
        reason = "each call makes a new temporary folder"
    )]
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

/// A fresh run's id.
#[cfg(test)]
pub(crate) fn test_run_id() -> RunId {
    RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id")
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

/// Writes `event`, a session event's `type` and `payload` as JSON, to `session_id`'s log through
/// the daemon's insert, occurring at `occurred_at` and with `body` stored as an append stores it,
/// across rows where an append would cut it so, and returns the event's own row's sequence and
/// event id.
#[cfg(test)]
pub(crate) fn insert_test_event(
    writer: &Connection,
    session_id: SessionId,
    event: serde_json::Value,
    body: Option<&str>,
    occurred_at: &str,
) -> (i64, String) {
    let event: SessionEvent = serde_json::from_value(event).expect("the test writes an event");
    let envelope = UnsequencedEventEnvelope::new(
        SessionEventDraft::of_session(session_id, &event)
            .expect("the test's event passes its checks"),
        EventOccurredAt::new(occurred_at.to_owned()).expect("the test writes a stored instant"),
        None,
        None,
        SESSION_EVENT_VERSION.clone(),
    );
    let id = envelope.id.as_str().to_owned();
    let rows = compose_rows(envelope, body.map(str::to_owned), monotonic_ns_now())
        .expect("the test's rows compose");
    let mut encoder = BodyEncoder::new();
    let sequences: Vec<SafeInt<0>> = rows
        .iter()
        .map(|row| {
            insert_session_event(writer, &mut encoder, row).expect("the test's row is written")
        })
        .collect();
    (i64::from(sequences[0]), id)
}
