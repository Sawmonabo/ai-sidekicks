//! The `session_events` row write, run on the database writer's connection: it reads the session's
//! head and inserts the row at the next sequence in one step, so two appends never derive one
//! sequence. The same step advances the session's projection cursor, because every projection row
//! an event moves is written in that event's own write. The run an event belongs to, which its
//! typed event names, is written to its own columns, so no write or read parses the payload for
//! it. It also owns the clock a row's `monotonic_ns` reads.

use std::sync::{Arc, LazyLock};
use std::time::Instant;

use rusqlite::{Connection, OptionalExtension, named_params};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::UuidText;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::database::schema::recovery::ProjectionCursorState;
use crate::database::statement::DATABASE_NOW_SQL;
use crate::events::session::appender::UnsequencedEventEnvelope;
use sidekicks_contracts::wire::id::mint_uuid_v7;

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
       run_id, run_version, turn_number
     ) VALUES (
       @id, @session_id, @sequence, @occurred_at, @monotonic_ns,
       @category, @type, @actor, @payload,
       @correlation_id, @causation_id, @version, @content_payload,
       @run_id, @run_version, @turn_number
     )";

const HEAD_SEQUENCE_SQL: &str = "SELECT sequence
       FROM session_events
      WHERE session_id = ?
      ORDER BY sequence DESC
      LIMIT 1";

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
