//! The `session_events` row write, run on the database writer's connection: it reads the session's
//! head and inserts the row at the next sequence in one step, so two appends never derive one
//! sequence. The same step advances the session's projection cursor, because every projection row
//! an event moves is written in that event's own write. The run an event belongs to, which its
//! typed event names, is written to its own columns, so no write or read parses the payload for
//! it. A piece of a run's reply or reasoning is stamped with the row it joins: the newest earlier
//! piece of the same run, type, provider message and block, unless its run's turn, run or
//! rollback ended that row since, decided here once so every read sees the same rows; a stored
//! part of a tool completion's patched files joins its completion's row the same way, keyed by the
//! completion's own id, and carries its place in the file list. A tool completion's row is
//! stamped with the call it completes, so the call's patch read finds it by an index. It also owns
//! the clock a row's `monotonic_ns` reads.

use std::sync::{Arc, LazyLock};
use std::time::Instant;

use rusqlite::{Connection, OptionalExtension, named_params};
use serde_json::Value;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::run_attribution::transcript_run_id_of;
use sidekicks_contracts::wire::id::UuidText;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::database::schema::recovery::ProjectionCursorState;
use crate::database::statement::DATABASE_NOW_SQL;
use crate::events::session::appender::UnsequencedEventEnvelope;
use crate::transcript::rejoin::ROW_ENDING_EVENT_TYPES_SQL;
use crate::uuid_v7::mint_uuid_v7;

/// The instant the daemon's clock counts from: the first read of [`monotonic_ns_now`], which the
/// daemon's start makes, so zero is the start.
static DAEMON_START: LazyLock<Instant> = LazyLock::new(Instant::now);

/// Nanoseconds since the daemon's start on the monotonic clock, the value a row's `monotonic_ns`
/// stores.
pub(crate) fn monotonic_ns_now() -> i64 {
    i64::try_from(DAEMON_START.elapsed().as_nanos())
        .expect("an i64 of nanoseconds covers 292 years of uptime")
}

/// A `session_events` row as bound, before its sequence exists: the event in its stored form,
/// shared with the commit hook that publishes it, beside what only the row holds.
#[derive(Debug)]
pub(crate) struct SessionEventRow {
    /// The event as stored, its `occurredAt` in the form `YYYY-MM-DDTHH:MM:SS.sssZ`.
    pub(crate) envelope: Arc<UnsequencedEventEnvelope>,
    /// The payload as JSON text, serialized on the appending task.
    pub(crate) payload: String,
    /// [`monotonic_ns_now`] when the event was appended.
    pub(crate) monotonic_ns: i64,
    /// The event's body as stored, kept out of the payload, `None` when it carries none.
    pub(crate) content_payload: Option<Vec<u8>>,
}

/// Why a row was not written.
#[derive(Debug, thiserror::Error)]
pub(crate) enum SessionEventInsertError {
    /// SQLite refused a statement, or the stored head is not an integer.
    #[error("the session_events row write failed")]
    Database(#[from] rusqlite::Error),
    /// The session's stored head has no next sequence a safe integer holds, so a further sequence
    /// would read back as another.
    #[error(
        "session {}'s head sequence {head} has no next sequence within the safe integers",
        .session_id
    )]
    NoNextSequence {
        /// The session.
        session_id: SessionId,
        /// Its stored head sequence.
        head: i64,
    },
}

const INSERT_SESSION_EVENT_SQL: &str = "INSERT INTO session_events (
       id, session_id, sequence, occurred_at, monotonic_ns,
       category, type, actor, payload,
       correlation_id, causation_id, version, content_payload,
       run_id, run_version, turn_number, join_key, joins_sequence, target_run_id, tool_call_id,
       patch_file_index, patch_text_offset
     ) VALUES (
       @id, @session_id, @sequence, @occurred_at, @monotonic_ns,
       @category, @type, @actor, @payload,
       @correlation_id, @causation_id, @version, @content_payload,
       @run_id, @run_version, @turn_number, @join_key, @joins_sequence, @target_run_id,
       @tool_call_id, @patch_file_index, @patch_text_offset
     )";

const HEAD_SEQUENCE_SQL: &str = "SELECT sequence
       FROM session_events
      WHERE session_id = ?
      ORDER BY sequence DESC
      LIMIT 1";

// The payload members that name the provider message and block a piece belongs to, and the call a
// tool completion completes.
const PROVIDER_MESSAGE_ID_PAYLOAD_KEY: &str = "providerMessageId";
const PROVIDER_BLOCK_PAYLOAD_KEY: &str = "providerBlock";
const TOOL_CALL_ID_PAYLOAD_KEY: &str = "toolCallId";

// The row a new piece joins, as its first piece's sequence: the run's newest piece of its type
// under its key, unless an event ending the run's rows came after it, so a row takes pieces until
// exactly the events that end it. The newest piece is one search of the key's covering index, and
// the end check one search of the run-and-type index per ending type, with no sort.
static JOINED_ROW_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT coalesce(newest.joins_sequence, newest.sequence)
       FROM (SELECT piece.sequence, piece.joins_sequence FROM session_events AS piece
              WHERE piece.session_id = @session_id AND piece.run_id = @run_id
                AND piece.type = @type AND piece.join_key = @join_key
              ORDER BY piece.sequence DESC
              LIMIT 1) AS newest
      WHERE NOT EXISTS (
        SELECT 1 FROM session_events AS ended
         WHERE ended.session_id = @session_id AND ended.type IN ({row_ends})
           AND ended.run_id = @run_id AND ended.sequence > newest.sequence)",
        row_ends = *ROW_ENDING_EVENT_TYPES_SQL,
    )
});

// A new session's cursor starts current; an existing one keeps its state, so a session marked for
// rebuilding stays marked until its rebuild lands.
static ADVANCE_PROJECTION_CURSOR_SQL: LazyLock<String> = LazyLock::new(|| {
    let current = <&'static str>::from(ProjectionCursorState::Current);
    format!(
        "INSERT INTO projection_cursors
    (id, session_id, last_sequence, state, updated_at)
  VALUES (@id, @session_id, @last_sequence, '{current}', {DATABASE_NOW_SQL})
  ON CONFLICT (session_id) DO UPDATE
    SET last_sequence = excluded.last_sequence,
        updated_at = excluded.updated_at"
    )
});

/// Inserts `row` at its session's next sequence on the writer's `connection`, advances the
/// session's projection cursor to it, and returns that sequence. Run inside the writer's
/// transaction; refuses when the stored head is not an integer or has no next safe integer.
pub(crate) fn insert_session_event(
    connection: &Connection,
    row: &SessionEventRow,
) -> Result<SafeInt<0>, SessionEventInsertError> {
    let event = &*row.envelope;
    let session_id = event.session_id().text();
    let run = event.run();
    let run_id = run.map(|run| run.run_id.text());
    let head: Option<i64> = connection
        .prepare_cached(HEAD_SEQUENCE_SQL)?
        .query_row([session_id.as_str()], |head_row| head_row.get(0))
        .optional()?;
    let sequence = match head {
        None => SafeInt::ZERO,
        Some(head) => head
            .checked_add(1)
            .and_then(|next| u64::try_from(next).ok())
            .and_then(SafeInt::new)
            .ok_or_else(|| SessionEventInsertError::NoNextSequence {
                session_id: event.session_id(),
                head,
            })?,
    };
    let stored_sequence = i64::from(sequence);
    // A piece with no run, a voice call's spoken answer, lands whole and always starts its row.
    let join_key = run_id.as_ref().and_then(|_| join_key_of(event));
    let patch_place = event.patch_part().map(|part| part.place);
    let joins_sequence: Option<i64> = match (&run_id, &join_key) {
        (Some(run_id), Some(join_key)) => connection
            .prepare_cached(&JOINED_ROW_SQL)?
            .query_row(
                named_params! {
                    "@session_id": session_id.as_str(),
                    "@run_id": run_id.as_str(),
                    "@type": event.event_type().as_str(),
                    "@join_key": join_key,
                },
                |joined| joined.get(0),
            )
            .optional()?,
        _ => None,
    };
    // An event that is no run's own but names one, an intervention naming its target, is filed
    // under that run.
    let target_run_id = run
        .is_none()
        .then(|| transcript_run_id_of(Some(event.payload())))
        .flatten();
    let tool_call_id = (run.is_some()
        && joins_sequence.is_none()
        && event.event_type() == SessionEventType::AgentToolCallCompleted)
        .then(|| event.payload().get(TOOL_CALL_ID_PAYLOAD_KEY))
        .flatten()
        .and_then(Value::as_str);
    connection
        .prepare_cached(INSERT_SESSION_EVENT_SQL)?
        .execute(named_params! {
            "@id": event.id.as_str(),
            "@session_id": session_id.as_str(),
            "@sequence": stored_sequence,
            "@occurred_at": event.occurred_at.as_str(),
            "@monotonic_ns": row.monotonic_ns,
            "@category": event.category().as_str(),
            "@type": event.event_type().as_str(),
            "@actor": event.actor.as_ref().map(FreeFormText::as_str),
            "@payload": row.payload,
            "@correlation_id": event.correlation_id.as_ref().map(FreeFormText::as_str),
            "@causation_id": event.causation_id.as_ref().map(FreeFormText::as_str),
            "@version": event.version.as_str(),
            "@content_payload": row.content_payload,
            "@run_id": run_id.as_ref().map(UuidText::as_str),
            "@run_version": run.and_then(|run| run.run_version).map(i64::from),
            "@turn_number": run.and_then(|run| run.turn_number).map(i64::from),
            "@join_key": join_key,
            "@joins_sequence": joins_sequence,
            "@target_run_id": target_run_id,
            "@tool_call_id": tool_call_id,
            "@patch_file_index": patch_place.map(|place| stored_index(place.file_index)),
            "@patch_text_offset": patch_place
                .and_then(|place| place.text_offset)
                .map(stored_index),
        })?;
    // Runs for the service's own sentinel session too, whose cursor is written and never read.
    connection
        .prepare_cached(&ADVANCE_PROJECTION_CURSOR_SQL)?
        .execute(named_params! {
            "@id": mint_uuid_v7().to_string(),
            "@session_id": session_id.as_str(),
            "@last_sequence": stored_sequence,
        })?;
    Ok(sequence)
}

/// The key a piece of a run's reply or reasoning joins its row by: its provider message's id and
/// content block, as one JSON text; for a tool completion that names patched files, its own id,
/// and for each stored part of its files, that completion's id; `None` for every other event.
fn join_key_of(event: &UnsequencedEventEnvelope) -> Option<String> {
    if let Some(part) = event.patch_part() {
        return Some(part.completion_id.as_str().to_owned());
    }
    let payload = event.payload();
    if matches!(
        event.event_type(),
        SessionEventType::AgentMessageSent | SessionEventType::AgentThinkingUpdated
    ) {
        return Some(
            serde_json::to_string(&(
                payload.get(PROVIDER_MESSAGE_ID_PAYLOAD_KEY),
                payload.get(PROVIDER_BLOCK_PAYLOAD_KEY),
            ))
            .expect("two JSON values serialize"),
        );
    }
    event
        .is_patch_bearing()
        .then(|| event.id.as_str().to_owned())
}

// A file's place or a text offset as its column stores it.
fn stored_index(index: usize) -> i64 {
    i64::try_from(index).expect("a file's place or a text offset lies far below 2^63")
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::session::id::SessionId;

    use crate::events::session::read::SessionEventReads;
    use crate::transcript::rejoin::RowReads;
    use crate::transcript::test_log::{AT, TranscriptTestLog};

    // Killed by a piece after its run's turn end, end or rollback joining the row that event
    // closed, by that row still listed as taking pieces, and by a piece of another run joining
    // under the same key.
    #[rstest]
    #[case::a_rollback("agent.run.rolledBack", json!({ "runVersion": 2, "targetPosition": 0 }))]
    #[case::a_turn_end("agent.turn.completed", json!({ "runVersion": 1, "turnNumber": 1 }))]
    #[case::a_run_end(
        "agent.run.completed",
        json!({ "runVersion": 2, "previousState": "running", "newState": "completed" })
    )]
    fn an_event_ending_a_row_ends_the_rejoin_of_its_key(
        #[case] ending_type: &str,
        #[case] mut ending_payload: Value,
    ) {
        let log = TranscriptTestLog::new();
        let other_run = RunId::try_from(crate::uuid_v7::mint_uuid_v7()).expect("a run id");
        let (anchor, _) = log.reply("m1", Some(0), "Before ");
        let (joined, _) = log.reply("m1", Some(0), "the end.");
        let (other, _) = log.piece(
            "agent.message.sent",
            other_run,
            "m1",
            Some(0),
            "Elsewhere.",
            AT,
        );
        ending_payload["sessionId"] = json!(log.session_id);
        ending_payload["runId"] = json!(log.run_id);
        let (ending, _) = log.write(
            json!({ "type": ending_type, "payload": ending_payload }),
            None,
        );
        let (after, _) = log.reply("m1", Some(0), "After the end.");

        let reader = log.reader();
        let joins: Vec<Option<i64>> = [anchor, joined, other, after]
            .iter()
            .map(|sequence| {
                reader
                    .query_row(
                        "SELECT joins_sequence FROM session_events WHERE sequence = ?1",
                        [sequence],
                        |row| row.get(0),
                    )
                    .expect("the test reads the stamp")
            })
            .collect();
        assert_eq!(joins, [None, Some(anchor), None, None]);
        let reads = SessionEventReads::new(&reader, &|_: &SessionId| None);
        let unended = RowReads::new(&reads, &reader, &log.session_id)
            .unended_rows(&[(anchor, joined)], ending)
            .expect("the rows read");
        assert!(unended.is_empty(), "{unended:?}");
    }
}
