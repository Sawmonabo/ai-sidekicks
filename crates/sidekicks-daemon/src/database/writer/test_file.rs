//! A database file for tests, opened as the daemon opens its own, holding the two tables an event
//! row write touches unless a test makes its own, and the event rows tests write to it.

use std::path::PathBuf;
use std::sync::Arc;

use rusqlite::Connection;
use serde_json::json;
use sidekicks_contracts::event::envelope::EventOccurredAt;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::session::id::SessionId;
use tempfile::TempDir;

use crate::database::connection::setup::apply_connection_pragmas;
use crate::events::session::appender::{SessionEventDraft, UnsequencedEventEnvelope};
use crate::events::session::insert::{SessionEventRow, monotonic_ns_now};
use crate::events::session::version::SESSION_EVENT_VERSION;
use crate::uuid_v7::mint_uuid_v7;

/// The daemon schema's `session_events` and `projection_cursors` tables, as the full schema
/// declares them, with the two turn indexes a turn write's guard reads and without the indexes
/// and triggers no row write here needs.
const EVENT_TABLES_SQL: &str = "
CREATE TABLE session_events (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL,
  sequence          INTEGER NOT NULL,
  occurred_at       TEXT NOT NULL,
  monotonic_ns      INTEGER NOT NULL,
  category          TEXT NOT NULL,
  type              TEXT NOT NULL,
  actor             TEXT,
  payload           TEXT NOT NULL DEFAULT '{}',
  content_payload   BLOB,
  correlation_id    TEXT,
  causation_id      TEXT,
  version           TEXT NOT NULL DEFAULT '1.0'
                    CHECK(version GLOB '[0-9]*.[0-9]*'),
  run_id            TEXT,
  run_version       INTEGER,
  turn_number       INTEGER,
  UNIQUE (session_id, sequence)
) STRICT;

CREATE UNIQUE INDEX idx_session_events_turn_end_once ON session_events(run_id, turn_number)
    WHERE category = 'runLifecycle'
    AND type IN ('agent.turn.completed', 'agent.turn.interrupted', 'agent.turn.failed');
CREATE UNIQUE INDEX idx_session_events_turn_start_once ON session_events(run_id, turn_number)
    WHERE category = 'runLifecycle' AND type = 'agent.turn.started';

CREATE TABLE projection_cursors (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL UNIQUE,
  last_sequence   INTEGER NOT NULL,
  state           TEXT NOT NULL DEFAULT 'current'
                  CHECK(state IN ('current', 'rebuilding', 'stale')),
  updated_at      TEXT NOT NULL
) STRICT;
";

/// A database file in a folder of its own, removed when this drops.
pub(crate) struct TestDatabase {
    folder: TempDir,
}

impl TestDatabase {
    /// A folder for a database file the opener creates.
    pub(crate) fn new() -> Self {
        Self {
            folder: tempfile::tempdir().expect("the test makes a temporary folder"),
        }
    }

    /// The database file's path.
    pub(crate) fn path(&self) -> PathBuf {
        self.folder.path().join("daemon.db")
    }

    /// The opener a writer runs on its thread: the file in WAL mode with every connection's
    /// setup, and the event tables created. Fails as SQLite does.
    pub(crate) fn opener(&self) -> impl FnOnce() -> rusqlite::Result<Connection> + Send + 'static {
        let open = self.opener_without_event_tables();
        move || {
            let connection = open()?;
            connection.execute_batch(EVENT_TABLES_SQL)?;
            Ok(connection)
        }
    }

    /// The opener for a file whose tables the test makes itself: the file in WAL mode with every
    /// connection's setup. Fails as SQLite does.
    pub(crate) fn opener_without_event_tables(
        &self,
    ) -> impl FnOnce() -> rusqlite::Result<Connection> + Send + 'static {
        let path = self.path();
        move || {
            let connection = Connection::open(path)?;
            connection.pragma_update(None, "journal_mode", "WAL")?;
            apply_connection_pragmas(&connection)?;
            Ok(connection)
        }
    }

    /// A second connection on the file, for a test to read what the writer committed.
    pub(crate) fn reader(&self) -> Connection {
        Connection::open(self.path()).expect("the test opens a second connection on its file")
    }
}

/// A fresh session's id.
pub(crate) fn test_session_id() -> SessionId {
    SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id")
}

/// The envelope of `event` on `session_id`'s log, occurring now, with no linkage.
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
