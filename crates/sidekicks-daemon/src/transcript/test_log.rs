//! A session's log for the transcript's tests: its runs, and the pieces and rows they write,
//! each through the daemon's insert so its join and run stamps are the ones a live append makes.

use rusqlite::{Connection, params};
use serde::Serialize;
use serde_json::{Value, json};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::attachment::write;

use crate::database::writer::test_file::{TestDatabase, insert_test_event, test_session_id};
use crate::uuid_v7::mint_uuid_v7;

/// The instant every test row occurs at unless a test names another.
pub(crate) const AT: &str = "2026-10-14T09:00:00.000Z";

/// A test database holding one session and its lead run.
pub(crate) struct TranscriptTestLog {
    /// The database.
    pub(crate) database: TestDatabase,
    /// The connection rows are written on.
    pub(crate) writer: Connection,
    /// The session.
    pub(crate) session_id: SessionId,
    /// The session's lead run, running.
    pub(crate) run_id: RunId,
}

impl TranscriptTestLog {
    /// A fresh session with its lead run.
    pub(crate) fn new() -> Self {
        let database = TestDatabase::new();
        let writer = database.opener()().expect("the test creates its database");
        let log = Self {
            database,
            writer,
            session_id: test_session_id(),
            run_id: RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id"),
        };
        log.store_run(log.run_id, None, "running");
        log
    }

    /// Stores `run_id` in the runs table in `state`, a child of `parent_run_id` where it names one.
    pub(crate) fn store_run(&self, run_id: RunId, parent_run_id: Option<RunId>, state: &str) {
        self.writer
            .execute(
                "INSERT INTO runs (run_id, session_id, parent_run_id, state, run_version)
                 VALUES (?1, ?2, ?3, ?4, 1)",
                params![
                    run_id.text().as_str(),
                    self.session_id.text().as_str(),
                    parent_run_id.map(|parent| parent.text().as_str().to_owned()),
                    state
                ],
            )
            .expect("the test writes the run");
    }

    /// A new child run of `parent_run_id` in `state`, stored with its `agent.run.queued` row.
    pub(crate) fn child_run(&self, parent_run_id: RunId, state: &str) -> RunId {
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        self.store_run(run_id, Some(parent_run_id), state);
        self.write(
            json!({
                "type": "agent.run.queued",
                "payload": {
                    "sessionId": self.session_id,
                    "runId": run_id,
                    "runVersion": 0,
                    "newState": "queued",
                    "agentId": mint_uuid_v7().to_string(),
                    "parentRunId": parent_run_id,
                    "reachedBy": "providerSubagent",
                },
            }),
            None,
        );
        run_id
    }

    /// Writes `event`, its `type` and `payload` as JSON, with `body`, occurring at [`AT`]; returns
    /// its sequence and event id.
    pub(crate) fn write(&self, event: Value, body: Option<&str>) -> (i64, String) {
        insert_test_event(&self.writer, self.session_id, event, body, AT)
    }

    /// Writes a piece of `event_type` (`agent.message.sent` or `agent.thinking.updated`) of
    /// `run_id`'s provider message `message_id`, in its block `block` where it names one.
    pub(crate) fn piece(
        &self,
        event_type: &str,
        run_id: RunId,
        message_id: &str,
        block: Option<u64>,
        body: &str,
        occurred_at: &str,
    ) -> (i64, String) {
        let mut payload = json!({
            "sessionId": self.session_id,
            "runId": run_id,
            "providerMessageId": message_id,
        });
        if let Some(index) = block {
            payload["providerBlock"] = json!({ "index": index, "attempt": 1 });
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
    pub(crate) fn reply(&self, message_id: &str, block: Option<u64>, body: &str) -> (i64, String) {
        self.piece(
            "agent.message.sent",
            self.run_id,
            message_id,
            block,
            body,
            AT,
        )
    }

    /// Writes a completed call of `tool_name` on `run_id`, `tool_call_id` naming it, with `body`.
    pub(crate) fn tool_completion(
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

    /// Writes an intervention on `target_run_id` in `state`, one of its seven event types.
    pub(crate) fn intervention(&self, target_run_id: RunId, state: &str) -> (i64, String) {
        let mut payload = json!({
            "sessionId": self.session_id,
            "interventionId": mint_uuid_v7().to_string(),
            "targetRunId": target_run_id,
            "type": "interrupt",
            "state": state,
            "actor": "daemon",
        });
        if state == "failed" {
            payload["failureReason"] = json!("dispatch threw");
        }
        self.write(
            json!({ "type": format!("agent.intervention.{state}"), "payload": payload }),
            None,
        )
    }

    /// Marks the events from `from` through `to` skipped, as a damaged session's repair does.
    pub(crate) fn skip(&self, from: i64, to: i64) {
        self.write(
            json!({
                "type": "session.damagedEvents.skipped",
                "payload": {
                    "sessionId": self.session_id,
                    "fromSequence": from,
                    "toSequence": to,
                },
            }),
            None,
        );
    }

    /// A second connection, to read what the writer committed.
    pub(crate) fn reader(&self) -> Connection {
        self.database.reader()
    }
}

/// `value` as the wire writes it, its byte members as their placeholders, beside its attachments.
pub(crate) fn wire_message<T: Serialize>(value: &T) -> (Value, Vec<bytes::Bytes>) {
    let (json, attachments) = write(value).expect("the test's value serializes");
    (
        serde_json::from_slice(&json).expect("a written message reads as JSON"),
        attachments,
    )
}
