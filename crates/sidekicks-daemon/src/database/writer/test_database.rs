//! A database file for tests, opened as the daemon opens its own, holding the two tables an event
//! row write touches, and the event rows tests write to it.

use std::path::PathBuf;

use rusqlite::Connection;
use sidekicks_contracts::event::envelope::EventEnvelopeType;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::session::id::SessionId;
use tempfile::TempDir;

use crate::database::connection::setup::apply_connection_pragmas;
use crate::events::session::insert::{SessionEventRow, monotonic_ns_now};
use crate::events::session::version::SESSION_EVENT_VERSION;
use crate::uuid_v7::mint_uuid_v7;

/// The daemon schema's `session_events` and `projection_cursors` tables, as the full schema
/// declares them, without the indexes and triggers no row write here needs.
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
  content_payload   TEXT,
  correlation_id    TEXT,
  causation_id      TEXT,
  version           TEXT NOT NULL DEFAULT '1.0'
                    CHECK(version GLOB '[0-9]*.[0-9]*'),
  run_id            TEXT GENERATED ALWAYS AS (
                      CASE WHEN json_valid(payload) THEN
                        CASE json_type(payload, '$.runId')
                          WHEN 'text' THEN json_extract(payload, '$.runId')
                        END
                      END
                    ) VIRTUAL,
  UNIQUE (session_id, sequence)
) STRICT;

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
        let path = self.path();
        move || {
            let connection = Connection::open(path)?;
            connection.pragma_update(None, "journal_mode", "WAL")?;
            apply_connection_pragmas(&connection)?;
            connection.execute_batch(EVENT_TABLES_SQL)?;
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
    SessionId::new(mint_uuid_v7().to_string()).expect("a minted UUID is a session id")
}

/// An event row of `event_type` for `session_id`, with an empty payload and no body.
pub(crate) fn session_event_row(
    session_id: &SessionId,
    event_type: SessionEventType,
) -> SessionEventRow {
    SessionEventRow {
        id: mint_uuid_v7().to_string(),
        session_id: session_id.clone(),
        occurred_at: "2026-10-14T12:00:00.000Z".to_owned(),
        monotonic_ns: monotonic_ns_now(),
        category: event_type.category(),
        event_type: EventEnvelopeType::from(event_type),
        actor: None,
        payload: "{}".to_owned(),
        correlation_id: None,
        causation_id: None,
        version: SESSION_EVENT_VERSION.clone(),
        content_payload: None,
    }
}
