//! A database file for tests, opened as the daemon opens its own with the schema of the parts a
//! test names, and the event rows tests write to it.

use std::path::PathBuf;
use std::sync::Arc;

use rusqlite::Connection;
use rusqlite::params;
use serde_json::json;
use sidekicks_contracts::{
    agent::definition::AgentId, event::envelope::EventOccurredAt, event::session::SessionEvent,
    run::id::RunId, session::id::SessionId, wire::id::mint_uuid_v7, wire::instant::WireInstant,
    wire::integer::SafeInt,
};
use sidekicks_std::cleanup_failures::CleanupFailures;
use tempfile::TempDir;

use crate::database::connection::writer_open::{DatabaseOpenError, open_database};
use crate::database::schema::{DatabaseSchema, SchemaParts};
use crate::events::{
    content::codec::BodyEncoder,
    log_service::compose_rows,
    session::{
        appender::{SessionEventDraft, UnsequencedEventEnvelope},
        insert::{SessionEventRow, insert_session_event, monotonic_ns_now},
        version::SESSION_EVENT_VERSION,
    },
};

/// A database file in a folder of its own, removed when this drops, and the schema it is opened
/// with.
pub struct TestDatabase {
    folder: TempDir,
    schema: DatabaseSchema,
}

impl TestDatabase {
    /// A folder for a database file the opener creates with `parts`, the list of the tables the
    /// test's own module can name.
    pub fn new(parts: SchemaParts) -> Self {
        Self {
            folder: tempfile::tempdir().expect("the test makes a temporary folder"),
            schema: parts.into_schema(),
        }
    }

    /// The database file's path.
    pub fn path(&self) -> PathBuf {
        self.folder.path().join("daemon.db")
    }

    /// The opener a writer runs on its thread: the daemon's own open of the file, which creates it
    /// with this database's schema. Fails as that open does.
    pub fn opener(
        &self,
    ) -> impl FnOnce() -> Result<Connection, CleanupFailures<DatabaseOpenError, rusqlite::Error>>
    + Send
    + 'static {
        let path = self.path();
        let schema = self.schema.clone();
        move || open_database(&path, &schema)
    }

    /// A second connection on the file, for a test to read what the writer committed.
    pub fn reader(&self) -> Connection {
        Connection::open(self.path()).expect("the test opens a second connection on its file")
    }
}

/// A fresh session's id.
pub fn test_session_id() -> SessionId {
    SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id")
}

/// Writes `session_id`'s creation, its lead bound to the provider `provider`, and answers the
/// lead's agent.
pub fn insert_lead(database: &TestDatabase, session_id: SessionId, provider: &str) -> AgentId {
    let agent_id = mint_uuid_v7().to_string();
    database
        .reader()
        .execute(
            "INSERT INTO session_events
               (id, session_id, sequence, occurred_at, monotonic_ns, category, type, payload)
             VALUES (?1, ?2, 0, ?3, 0, 'sessionLifecycle', 'session.created', ?4)",
            params![
                mint_uuid_v7().to_string(),
                session_id.text().as_str(),
                WireInstant::now().as_str(),
                json!({
                    "mainAgent": {
                        "agentId": agent_id,
                        "binding": { "providerName": provider },
                    },
                })
                .to_string(),
            ],
        )
        .expect("the test creates the session's lead");
    AgentId::new(&agent_id).expect("a minted UUID is an agent id")
}

/// A fresh run's id.
pub fn test_run_id() -> RunId {
    RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id")
}

/// The envelope of `event` on `session_id`'s log, occurring now, with no linkage.
pub fn test_envelope(session_id: SessionId, event: &SessionEvent) -> UnsequencedEventEnvelope {
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
pub fn session_event_row(session_id: &SessionId) -> SessionEventRow {
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
pub fn insert_test_event(
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
