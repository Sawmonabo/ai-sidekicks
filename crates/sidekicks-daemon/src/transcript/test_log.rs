//! A session's log for the transcript's tests: the store's session test log with its runs stored
//! beside its events, the run and turn events the transcript reads, and the rows it damages.

use rusqlite::{ToSql, params};
use serde::Serialize;
use serde_json::{Value, json};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::wire::attachment::write;

use crate::transcript::block_cut::{ChildStartsParse, MARKDOWN_PARSE};
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_store::database::schema::SchemaParts;
use sidekicks_store::events::test_log::SessionTestLog;

/// A text [`stalling_parse`] stalls on.
pub(crate) const STALLING_TEXT: &str = "THE-BLOCK-CUT-STALLS-HERE";

/// The markdown parse, except on a window holding [`STALLING_TEXT`], where every child it answers
/// starts at the window's start, so the cut cannot advance.
pub(crate) fn stalling_parse() -> ChildStartsParse {
    let mut markdown = MARKDOWN_PARSE();
    Box::new(move |text| {
        if text.contains(STALLING_TEXT) {
            vec![0; 3]
        } else {
            markdown(text)
        }
    })
}

/// A session's log whose lead run is stored in the runs table, in a database holding the session's
/// tables.
pub(crate) struct TranscriptTestLog {
    /// The store's session log it writes through: its database, session, lead run and events.
    pub(crate) session_log: SessionTestLog,
}

impl TranscriptTestLog {
    /// A fresh session with its lead run, in a database of `parts`, which hold the runs table.
    pub(crate) fn new(parts: SchemaParts) -> Self {
        let log = Self {
            session_log: SessionTestLog::new(parts),
        };
        log.store_run(log.session_log.run_id, None, "running");
        log
    }

    /// Stores `run_id` in the runs table in `state`, a child of `parent_run_id` where it names one.
    pub(crate) fn store_run(&self, run_id: RunId, parent_run_id: Option<RunId>, state: &str) {
        self.session_log
            .writer
            .execute(
                "INSERT INTO runs (run_id, session_id, parent_run_id, state, run_version)
                 VALUES (?1, ?2, ?3, ?4, 1)",
                params![
                    run_id.text().as_str(),
                    self.session_log.session_id.text().as_str(),
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
        self.session_log.write(
            json!({
                "type": "agent.run.queued",
                "payload": {
                    "sessionId": self.session_log.session_id,
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

    /// Writes an intervention on `target_run_id` in `state`, one of its seven event types.
    pub(crate) fn intervention(&self, target_run_id: RunId, state: &str) -> (i64, String) {
        let mut payload = json!({
            "sessionId": self.session_log.session_id,
            "interventionId": mint_uuid_v7().to_string(),
            "targetRunId": target_run_id,
            "type": "interrupt",
            "state": state,
            "actor": "daemon",
        });
        if state == "failed" {
            payload["failureReason"] = json!("dispatch threw");
        }
        self.session_log.write(
            json!({ "type": format!("agent.intervention.{state}"), "payload": payload }),
            None,
        )
    }

    /// Marks the events from `from` through `to` skipped, as a damaged session's repair does.
    pub(crate) fn skip(&self, from: i64, to: i64) {
        self.session_log.write(
            json!({
                "type": "session.damagedEvents.skipped",
                "payload": {
                    "sessionId": self.session_log.session_id,
                    "fromSequence": from,
                    "toSequence": to,
                },
            }),
            None,
        );
    }

    /// Writes the end of turn `turn_number` of `run_id`.
    pub(crate) fn turn_end(&self, run_id: RunId, turn_number: u64) -> (i64, String) {
        self.session_log.write(
            json!({
                "type": "agent.turn.completed",
                "payload": {
                    "sessionId": self.session_log.session_id,
                    "runId": run_id,
                    "runVersion": 1,
                    "turnNumber": turn_number,
                },
            }),
            None,
        )
    }

    /// Damages the row at `sequence` as `damage` says, its payload still valid JSON.
    pub(crate) fn damage_row(&self, sequence: i64, damage: RowDamage) {
        match damage {
            RowDamage::Encoding => self.set_payload_value(sequence, "$.contentEncoding", "zstdx"),
            RowDamage::EncodingByte => self.flip_encoding_high_bit(sequence),
            RowDamage::Length => self.set_payload_value(sequence, "$.contentLength", "many"),
            RowDamage::ToolName => self.set_payload_value(sequence, "$.toolName", 5),
            RowDamage::Frame(frame) => self.session_log.damage_frame(sequence, frame),
        }
    }

    // Sets the payload value at the JSON `path` of the row at `sequence` to `value`.
    fn set_payload_value(&self, sequence: i64, path: &str, value: impl ToSql) {
        self.session_log
            .writer
            .execute(
                "UPDATE session_events SET payload = json_set(payload, ?1, ?2) WHERE sequence = ?3",
                params![path, value, sequence],
            )
            .expect("the payload is written");
    }

    // Flips the high bit of the `z` in the `"zstd"` the payload of the row at `sequence` names, so
    // that text is no longer UTF-8; fails the test when the payload names no `zstd` encoding.
    fn flip_encoding_high_bit(&self, sequence: i64) {
        self.session_log
            .writer
            .execute(
                "UPDATE session_events SET payload = CAST(replace(CAST(payload AS BLOB), \
                 CAST('\"zstd\"' AS BLOB), X'22FA73746422') AS TEXT) WHERE sequence = ?1",
                [sequence],
            )
            .expect("the payload is written");
        let is_flipped: bool = self
            .session_log
            .writer
            .query_row(
                "SELECT json_valid(payload) AND instr(CAST(payload AS BLOB), X'22FA73746422') > 0 \
                 FROM session_events WHERE sequence = ?1",
                [sequence],
                |row| row.get(0),
            )
            .expect("the payload reads");
        assert!(
            is_flipped,
            "the payload names the zstd encoding and still parses"
        );
    }
}

/// How a test damages a log row after it was written, its payload still valid JSON.
#[derive(Clone, Copy, Debug)]
pub(crate) enum RowDamage {
    /// Its payload names an encoding no build writes.
    Encoding,
    /// Its payload's `zstd` encoding has one bit flipped, so that text is not UTF-8.
    EncodingByte,
    /// Its payload states its length as text.
    Length,
    /// Its payload names its tool with a number.
    ToolName,
    /// Its stored body fails the checksum of the frame at this place, counted from 0.
    Frame(usize),
}

/// `value` as the wire writes it, its byte members as their placeholders, beside its attachments.
pub(crate) fn wire_message<T: Serialize>(value: &T) -> (Value, Vec<bytes::Bytes>) {
    let (json, attachments) = write(value).expect("the test's value serializes");
    (
        serde_json::from_slice(&json).expect("a written message reads as JSON"),
        attachments,
    )
}

/// The block starts `member` holds, as [`wire_message`] wrote it beside `attachments`: the UTF-16
/// offsets its attachment packs, none when it is absent.
pub(crate) fn wire_block_starts(member: &Value, attachments: &[bytes::Bytes]) -> Vec<u32> {
    member["$bytes"].as_u64().map_or_else(Vec::new, |index| {
        let index = usize::try_from(index).expect("an attachment index fits");
        attachments[index]
            .as_chunks::<4>()
            .0
            .iter()
            .map(|&start| u32::from_le_bytes(start))
            .collect()
    })
}
