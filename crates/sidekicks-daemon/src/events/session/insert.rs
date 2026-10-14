//! The `session_events` row write, run on the database writer's connection: it reads the session's
//! head and inserts the row at the next sequence in one step, so two appends never derive one
//! sequence. The same step advances the session's projection cursor, because every projection row
//! an event moves is written in that event's own write. It also owns the clock a row's
//! `monotonic_ns` reads.

use std::sync::LazyLock;
use std::time::Instant;

use rusqlite::{Connection, OptionalExtension, named_params};
use sidekicks_contracts::event::envelope::{EventCategory, EventEnvelopeType};
use sidekicks_contracts::event::version::EventEnvelopeVersion;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;

use crate::database::statement::DATABASE_NOW_SQL;
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

/// A `session_events` row as bound, before its sequence exists.
#[derive(Clone, Debug)]
pub(crate) struct SessionEventRow {
    /// The event's id.
    pub(crate) id: String,
    /// The session the event belongs to.
    pub(crate) session_id: SessionId,
    /// When the event occurred, in the stored form `YYYY-MM-DDTHH:MM:SS.sssZ`.
    pub(crate) occurred_at: String,
    /// [`monotonic_ns_now`] when the event was appended.
    pub(crate) monotonic_ns: i64,
    /// The event's category.
    pub(crate) category: EventCategory,
    /// The event's type, as the envelope keeps it.
    pub(crate) event_type: EventEnvelopeType,
    /// Who acted, `None` for a system event.
    pub(crate) actor: Option<String>,
    /// The payload as JSON text.
    pub(crate) payload: String,
    /// The id that ties this event to others of one operation.
    pub(crate) correlation_id: Option<String>,
    /// The id of what caused this event.
    pub(crate) causation_id: Option<String>,
    /// The producer's envelope version.
    pub(crate) version: EventEnvelopeVersion,
    /// The event's body, kept out of the payload, `None` when it carries none.
    pub(crate) content_payload: Option<String>,
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
        .session_id.as_str()
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
       correlation_id, causation_id, version, content_payload
     ) VALUES (
       @id, @session_id, @sequence, @occurred_at, @monotonic_ns,
       @category, @type, @actor, @payload,
       @correlation_id, @causation_id, @version, @content_payload
     )";

const HEAD_SEQUENCE_SQL: &str = "SELECT sequence
       FROM session_events
      WHERE session_id = ?
      ORDER BY sequence DESC
      LIMIT 1";

// A new session's cursor starts current; an existing one keeps its state, so a session marked for
// rebuilding stays marked until its rebuild lands.
static ADVANCE_PROJECTION_CURSOR_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO projection_cursors
    (id, session_id, last_sequence, state, updated_at)
  VALUES (@id, @session_id, @last_sequence, 'current', {DATABASE_NOW_SQL})
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
    let head: Option<i64> = connection
        .prepare_cached(HEAD_SEQUENCE_SQL)?
        .query_row([row.session_id.as_str()], |head_row| head_row.get(0))
        .optional()?;
    let sequence = match head {
        None => SafeInt::ZERO,
        Some(head) => head
            .checked_add(1)
            .and_then(|next| u64::try_from(next).ok())
            .and_then(SafeInt::new)
            .ok_or_else(|| SessionEventInsertError::NoNextSequence {
                session_id: row.session_id.clone(),
                head,
            })?,
    };
    let stored_sequence =
        i64::try_from(sequence.get()).expect("a safe integer fits SQLite's INTEGER");
    connection
        .prepare_cached(INSERT_SESSION_EVENT_SQL)?
        .execute(named_params! {
            "@id": row.id,
            "@session_id": row.session_id.as_str(),
            "@sequence": stored_sequence,
            "@occurred_at": row.occurred_at,
            "@monotonic_ns": row.monotonic_ns,
            "@category": row.category.as_str(),
            "@type": row.event_type.as_str(),
            "@actor": row.actor,
            "@payload": row.payload,
            "@correlation_id": row.correlation_id,
            "@causation_id": row.causation_id,
            "@version": row.version.as_str(),
            "@content_payload": row.content_payload,
        })?;
    // Runs for the service's own sentinel session too, whose cursor is written and never read.
    connection
        .prepare_cached(&ADVANCE_PROJECTION_CURSOR_SQL)?
        .execute(named_params! {
            "@id": mint_uuid_v7().to_string(),
            "@session_id": row.session_id.as_str(),
            "@last_sequence": stored_sequence,
        })?;
    Ok(sequence)
}
