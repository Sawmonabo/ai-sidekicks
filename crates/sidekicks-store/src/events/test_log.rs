//! A session's log for tests: the events and their bodies written through the daemon's insert, so
//! each row's join and run stamps are the ones a live append makes, and a stored body damaged.

use rusqlite::Connection;
use serde_json::{Value, json};
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use zstd::zstd_safe;

use crate::database::schema::SchemaParts;
use crate::database::statement::{WriteStatement, run_statement};
use crate::database::writer::test_file::{TestDatabase, insert_test_event, test_session_id};
use crate::events::session::appender::UnsequencedEventEnvelope;
use crate::events::session::version::SESSION_EVENT_VERSION;

/// The instant every test row occurs at unless a test names another.
pub const AT: &str = "2026-10-14T09:00:00.000Z";

/// A test database holding one session's log, its events naming one lead run.
pub struct SessionTestLog {
    /// The database.
    pub database: TestDatabase,
    /// The connection rows are written on.
    pub writer: Connection,
    /// The session.
    pub session_id: SessionId,
    /// The run the session's lead events name.
    pub run_id: RunId,
}

impl SessionTestLog {
    /// A fresh session's log in a database holding the tables of `parts`.
    pub fn new(parts: SchemaParts) -> Self {
        let database = TestDatabase::new(parts);
        let writer = database.opener()().expect("the test creates its database");
        Self {
            database,
            writer,
            session_id: test_session_id(),
            run_id: RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id"),
        }
    }

    /// Writes `event`, its `type` and `payload` as JSON, with `body`, occurring at [`AT`]; returns
    /// its sequence and event id.
    pub fn write(&self, event: Value, body: Option<&str>) -> (i64, String) {
        insert_test_event(&self.writer, self.session_id, event, body, AT)
    }

    /// Writes a piece of `event_type` (`agent.message.sent` or `agent.thinking.updated`) of
    /// `run_id`'s provider message `message_id`, in its block `block`, an `(index, attempt)` pair,
    /// where it names one.
    pub fn piece(
        &self,
        event_type: &str,
        run_id: RunId,
        message_id: &str,
        block: Option<(u64, u64)>,
        body: &str,
        occurred_at: &str,
    ) -> (i64, String) {
        let mut payload = json!({
            "sessionId": self.session_id,
            "runId": run_id,
            "providerMessageId": message_id,
        });
        if let Some((index, attempt)) = block {
            payload["providerBlock"] = json!({ "index": index, "attempt": attempt });
        }
        insert_test_event(
            &self.writer,
            self.session_id,
            json!({ "type": event_type, "payload": payload }),
            Some(body),
            occurred_at,
        )
    }

    /// Writes a reply piece of the lead run at [`AT`].
    pub fn reply(&self, message_id: &str, block: Option<(u64, u64)>, body: &str) -> (i64, String) {
        self.piece(
            "agent.message.sent",
            self.run_id,
            message_id,
            block,
            body,
            AT,
        )
    }

    /// Writes a completed `edit` call on `run_id`, `tool_call_id` naming it, with `body`.
    pub fn tool_completion(
        &self,
        run_id: RunId,
        tool_call_id: &str,
        omitted_patches: Option<Value>,
        body: Option<&str>,
    ) -> (i64, String) {
        let mut payload = json!({
            "sessionId": self.session_id,
            "runId": run_id,
            "toolName": "edit",
            "toolCallId": tool_call_id,
        });
        if let Some(omitted_patches) = omitted_patches {
            payload["omittedPatches"] = omitted_patches;
        }
        self.write(
            json!({ "type": "agent.toolCall.completed", "payload": payload }),
            body,
        )
    }

    /// Writes a row of `event_type` of the lead run's `bash` call `tool_call_id`, with `members`
    /// beside the members every tool row carries and `body`; returns its sequence.
    pub fn tool_row(
        &self,
        event_type: &str,
        tool_call_id: &str,
        members: &Value,
        body: Option<&str>,
    ) -> i64 {
        let mut payload = json!({
            "sessionId": self.session_id,
            "runId": self.run_id,
            "toolName": "bash",
            "toolCallId": tool_call_id,
        });
        for (name, value) in members.as_object().expect("the members are an object") {
            payload[name] = value.clone();
        }
        self.write(json!({ "type": event_type, "payload": payload }), body)
            .0
    }

    /// A second connection, to read what the writer committed.
    pub fn reader(&self) -> Connection {
        self.database.reader()
    }

    /// Flips the checksum, its last byte, of the frame at `frame`, counted from 0, of the body
    /// stored at `sequence`, so decoding that frame fails.
    pub fn damage_frame(&self, sequence: i64, frame: usize) {
        let mut stored: Vec<u8> = self
            .writer
            .query_row(
                "SELECT content_payload FROM session_events WHERE sequence = ?1",
                [sequence],
                |row| row.get(0),
            )
            .expect("the body reads");
        let mut frame_end = 0;
        for _ in 0..=frame {
            frame_end += zstd_safe::find_frame_compressed_size(&stored[frame_end..])
                .expect("the stored frames are whole");
        }
        stored[frame_end - 1] ^= 0xff;
        self.writer
            .execute(
                "UPDATE session_events SET content_payload = ?1 WHERE sequence = ?2",
                rusqlite::params![stored, sequence],
            )
            .expect("the damaged body is written");
    }
}

/// The stored form of `envelope` at `sequence`, as a projection rebuild reads it back from the log.
pub fn stored_envelope(envelope: &UnsequencedEventEnvelope, sequence: usize) -> EventEnvelope {
    serde_json::from_value(json!({
        "id": envelope.id.as_str(),
        "sessionId": envelope.session_id(),
        "sequence": sequence,
        "occurredAt": envelope.occurred_at.as_str(),
        "category": envelope.category(),
        "type": envelope.event_type(),
        "payload": envelope.payload(),
        "version": &*SESSION_EVENT_VERSION,
    }))
    .expect("the stored envelope reads")
}

/// Runs each of `statements` on `connection` in order, as a projection's write does.
pub fn run_write_statements(connection: &Connection, statements: &[WriteStatement]) {
    for statement in statements {
        run_statement(connection, statement).expect("the projection's statement runs");
    }
}
