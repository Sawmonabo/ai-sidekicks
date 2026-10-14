//! The `session_events` reads, run on the daemon's read-only connection: a session's head, the rows
//! after a log position, of every type or of named types, the rows up to one, the rows of a
//! sequence window and the rows at named sequences, each in sequence order, one row by its event id
//! with its stored body, and the check of a cursor against the head. A row crosses in from the
//! database file, so each one is checked against the envelope contract on the way out. A range the
//! session skipped past as damaged is never read, and while its history is damaged no read goes
//! past its last good point.

use std::sync::LazyLock;

use garde::Validate as _;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde_json::{Map, Value};
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::session::event_cursor::{
    EventCursor, EventCursorUnresolvable, START_OF_LOG_POSITION, decode_event_cursor,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::MAX_SAFE_SIGNED_INTEGER;

use crate::events::content::read::StoredEventContentRow;
use crate::events::session::skipped_ranges::outside_skipped_ranges_sql;

/// A stored event row that is not a well-formed event envelope, which only a write outside the
/// append path can leave; `sequence` is the row's.
#[derive(Debug, thiserror::Error)]
#[error(
    "the stored event {event_id} at sequence {sequence} is not a well-formed event, so the row \
     was written outside the append path"
)]
pub(crate) struct MalformedStoredEventError {
    /// The row's event id.
    pub(crate) event_id: String,
    /// The row's sequence.
    pub(crate) sequence: i64,
    /// What is wrong with it.
    #[source]
    pub(crate) fault: MalformedStoredEventFault,
}

/// What makes a stored row not a well-formed event envelope.
#[derive(Debug, thiserror::Error)]
pub(crate) enum MalformedStoredEventFault {
    /// `session_events.payload` is not JSON.
    #[error("its payload column is not JSON")]
    PayloadNotJson(#[source] serde_json::Error),
    /// The columns do not read as an envelope.
    #[error("its columns do not read as an event envelope")]
    NotAnEnvelope(#[source] serde_json::Error),
    /// The envelope breaks one of its checks.
    #[error("its envelope breaks one of the envelope's checks")]
    Check(#[source] garde::Report),
}

/// Why a read of a session's log failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum SessionLogReadError {
    /// SQLite refused the read, or a column holds a type its schema forbids.
    #[error("a session_events read failed")]
    Database(#[from] rusqlite::Error),
    /// A row is not a well-formed event envelope.
    #[error(transparent)]
    Malformed(#[from] MalformedStoredEventError),
}

/// Which of the events after a position a read takes; every one when a member is `None`.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct SessionEventFilter<'types> {
    /// Only events of these types.
    pub(crate) event_types: Option<&'types [&'types str]>,
    /// Only events before this sequence.
    pub(crate) before_sequence: Option<i64>,
}

const SELECTED_COLUMNS: &str = "id, session_id, sequence, occurred_at, category, type, actor, \
                                payload, correlation_id, causation_id, version";

// The bound of a read that has none: no session's log reaches this sequence.
const NO_SEQUENCE_BOUND: i64 = MAX_SAFE_SIGNED_INTEGER;

const HEAD_SQL: &str = "SELECT MAX(sequence) FROM session_events WHERE session_id = ?";

static AFTER_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {SELECTED_COLUMNS}
       FROM session_events AS event
      WHERE session_id = ? AND sequence > ? AND sequence < ?
        AND {}
      ORDER BY sequence ASC
      LIMIT ?",
        outside_skipped_ranges_sql("event")
    )
});

static AFTER_OF_TYPES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {SELECTED_COLUMNS}
       FROM session_events AS event
      WHERE session_id = ? AND sequence > ? AND sequence < ?
        AND type IN (SELECT value FROM json_each(?))
        AND {}
      ORDER BY sequence ASC
      LIMIT ?",
        outside_skipped_ranges_sql("event")
    )
});

// Newest first so the limit keeps the rows nearest the position; the read reverses them.
static BEFORE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {SELECTED_COLUMNS}
       FROM session_events AS event
      WHERE session_id = ? AND sequence <= ? AND sequence < ?
        AND {}
      ORDER BY sequence DESC
      LIMIT ?",
        outside_skipped_ranges_sql("event")
    )
});

static WINDOW_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {SELECTED_COLUMNS}
       FROM session_events AS event
      WHERE session_id = ? AND sequence BETWEEN ? AND ? AND sequence < ?
        AND {}
      ORDER BY sequence ASC",
        outside_skipped_ranges_sql("event")
    )
});

static AT_SEQUENCES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {SELECTED_COLUMNS}
       FROM session_events AS event
      WHERE session_id = ? AND sequence IN (SELECT value FROM json_each(?)) AND sequence < ?
        AND {}
      ORDER BY sequence ASC",
        outside_skipped_ranges_sql("event")
    )
});

static STORED_ROW_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {SELECTED_COLUMNS}, content_payload
       FROM session_events AS event
      WHERE session_id = ? AND id = ? AND sequence < ?
        AND {}",
        outside_skipped_ranges_sql("event")
    )
});

/// Answers the sequence a damaged session's reads stop before, `None` for a session that reads
/// whole.
pub(crate) type DamagedFromSequenceReader = dyn Fn(&SessionId) -> Option<i64> + Send + Sync;

/// Whether the event aliased `event_alias` is one the log can read: before `@read_bound`, which
/// [`session_read_bound`] gives, and outside every range its session skipped as damaged.
pub(crate) fn readable_event_sql(event_alias: &str) -> String {
    format!(
        "{event_alias}.sequence < @read_bound AND {}",
        outside_skipped_ranges_sql(event_alias)
    )
}

/// The sequence a read of `session_id` stops before: the earlier of the read's own
/// `before_sequence` and the session's last good point while its history is damaged, which
/// `read_damaged_from_sequence` answers, else past every sequence.
pub(crate) fn session_read_bound(
    read_damaged_from_sequence: impl Fn(&SessionId) -> Option<i64>,
    session_id: &SessionId,
    before_sequence: Option<i64>,
) -> i64 {
    before_sequence
        .unwrap_or(NO_SEQUENCE_BOUND)
        .min(read_damaged_from_sequence(session_id).unwrap_or(NO_SEQUENCE_BOUND))
}

/// The synchronous reads of one session's log on a read-only connection; every list is in
/// ascending sequence order. Each read fails with [`SessionLogReadError::Malformed`] when a row is
/// not a valid event envelope, and with [`SessionLogReadError::Database`] when SQLite refuses it.
pub(crate) struct SessionEventReads<'reader, DamagedFrom> {
    reader: &'reader Connection,
    read_damaged_from_sequence: DamagedFrom,
}

impl<'reader, DamagedFrom> SessionEventReads<'reader, DamagedFrom>
where
    DamagedFrom: Fn(&SessionId) -> Option<i64>,
{
    /// The reads on `reader`; `read_damaged_from_sequence` answers the sequence a damaged
    /// session's reads stop before, `None` for a session that reads whole.
    pub(crate) fn new(
        reader: &'reader Connection,
        read_damaged_from_sequence: DamagedFrom,
    ) -> Self {
        Self {
            reader,
            read_damaged_from_sequence,
        }
    }

    /// The session's highest sequence it reads to, below its last good point while its history is
    /// damaged, or `None` when it has no such event.
    pub(crate) fn read_head(
        &self,
        session_id: &SessionId,
    ) -> Result<Option<i64>, SessionLogReadError> {
        let head: Option<i64> = self
            .reader
            .prepare_cached(HEAD_SQL)?
            .query_row([session_id.as_str()], |row| row.get(0))?;
        Ok(head
            .map(|head| head.min(self.read_bound(session_id, None) - 1))
            .filter(|&read_to| read_to >= 0))
    }

    /// Up to `limit` events with a sequence greater than `after_position`, every one when `limit`
    /// is negative, and only those `filter` takes.
    pub(crate) fn read_after(
        &self,
        session_id: &SessionId,
        after_position: i64,
        limit: i64,
        filter: SessionEventFilter<'_>,
    ) -> Result<Vec<EventEnvelope>, SessionLogReadError> {
        let before = self.read_bound(session_id, filter.before_sequence);
        match filter.event_types {
            None => self.read_rows(
                &AFTER_SQL,
                params![session_id.as_str(), after_position, before, limit],
            ),
            Some(event_types) => self.read_rows(
                &AFTER_OF_TYPES_SQL,
                params![
                    session_id.as_str(),
                    after_position,
                    before,
                    serde_json::to_string(event_types).expect("a list of strings serializes"),
                    limit
                ],
            ),
        }
    }

    /// The newest `limit` events with a sequence at or below `before_position`.
    pub(crate) fn read_before(
        &self,
        session_id: &SessionId,
        before_position: i64,
        limit: i64,
    ) -> Result<Vec<EventEnvelope>, SessionLogReadError> {
        let mut rows = self.read_rows(
            &BEFORE_SQL,
            params![
                session_id.as_str(),
                before_position,
                self.read_bound(session_id, None),
                limit
            ],
        )?;
        rows.reverse();
        Ok(rows)
    }

    /// The events with a sequence from `from_sequence` to `to_sequence`, both included.
    pub(crate) fn read_window(
        &self,
        session_id: &SessionId,
        from_sequence: i64,
        to_sequence: i64,
    ) -> Result<Vec<EventEnvelope>, SessionLogReadError> {
        self.read_rows(
            &WINDOW_SQL,
            params![
                session_id.as_str(),
                from_sequence,
                to_sequence,
                self.read_bound(session_id, None)
            ],
        )
    }

    /// The events at the given sequences; a sequence the session holds no event at reads none.
    pub(crate) fn read_at_sequences(
        &self,
        session_id: &SessionId,
        sequences: &[i64],
    ) -> Result<Vec<EventEnvelope>, SessionLogReadError> {
        self.read_rows(
            &AT_SEQUENCES_SQL,
            params![
                session_id.as_str(),
                serde_json::to_string(sequences).expect("a list of integers serializes"),
                self.read_bound(session_id, None)
            ],
        )
    }

    /// The event `event_id` with its stored body, or `None` when the session reads none.
    pub(crate) fn read_stored_row(
        &self,
        session_id: &SessionId,
        event_id: &str,
    ) -> Result<Option<StoredEventContentRow>, SessionLogReadError> {
        let stored = self
            .reader
            .prepare_cached(&STORED_ROW_SQL)?
            .query_row(
                params![
                    session_id.as_str(),
                    event_id,
                    self.read_bound(session_id, None)
                ],
                |row| {
                    Ok((
                        StoredEventRow::from_row(row)?,
                        row.get::<_, Option<String>>(STORED_EVENT_COLUMN_COUNT)?,
                    ))
                },
            )
            .optional()?;
        stored
            .map(|(row, content_payload)| {
                Ok(StoredEventContentRow {
                    envelope: row.into_envelope()?,
                    content_payload,
                })
            })
            .transpose()
    }

    fn read_bound(&self, session_id: &SessionId, before_sequence: Option<i64>) -> i64 {
        session_read_bound(
            &self.read_damaged_from_sequence,
            session_id,
            before_sequence,
        )
    }

    /// Runs one of the row-list statements and checks each row as an envelope, in the order read.
    fn read_rows(
        &self,
        sql: &str,
        bindings: impl rusqlite::Params,
    ) -> Result<Vec<EventEnvelope>, SessionLogReadError> {
        let rows = self
            .reader
            .prepare_cached(sql)?
            .query_map(bindings, StoredEventRow::from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows
            .into_iter()
            .map(StoredEventRow::into_envelope)
            .collect::<Result<Vec<_>, _>>()?)
    }
}

/// The log position `cursor` names, the start of the log when it is `None`, checked against the
/// session's `head`, which the caller reads before any page so a cursor past it cannot pass on a
/// later commit. Fails with [`EventCursorUnresolvable`] for a cursor that names no position or one
/// past the head.
pub(crate) fn resolve_event_cursor(
    cursor: Option<&EventCursor>,
    head: Option<i64>,
) -> Result<i64, EventCursorUnresolvable> {
    let Some(cursor) = cursor else {
        return Ok(START_OF_LOG_POSITION);
    };
    let position = decode_event_cursor(cursor)?;
    if position > head.unwrap_or(START_OF_LOG_POSITION) {
        return Err(EventCursorUnresolvable);
    }
    Ok(position)
}

// The columns `SELECTED_COLUMNS` names; a stored-row read's body column follows them.
const STORED_EVENT_COLUMN_COUNT: usize = 11;

/// A `session_events` row as the reads select it, before it is checked.
struct StoredEventRow {
    id: String,
    session_id: String,
    sequence: i64,
    occurred_at: String,
    category: String,
    event_type: String,
    actor: Option<String>,
    payload: String,
    correlation_id: Option<String>,
    causation_id: Option<String>,
    version: String,
}

impl StoredEventRow {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            session_id: row.get(1)?,
            sequence: row.get(2)?,
            occurred_at: row.get(3)?,
            category: row.get(4)?,
            event_type: row.get(5)?,
            actor: row.get(6)?,
            payload: row.get(7)?,
            correlation_id: row.get(8)?,
            causation_id: row.get(9)?,
            version: row.get(10)?,
        })
    }

    /// The row as an envelope, through the tolerant envelope read, which keeps an event type this
    /// build does not know as a stub. Storage keeps an absent correlation or causation id as
    /// NULL, which the envelope omits.
    fn into_envelope(self) -> Result<EventEnvelope, MalformedStoredEventError> {
        let malformed = |fault| MalformedStoredEventError {
            event_id: self.id.clone(),
            sequence: self.sequence,
            fault,
        };
        let payload: Value = serde_json::from_str(&self.payload)
            .map_err(|error| malformed(MalformedStoredEventFault::PayloadNotJson(error)))?;
        let mut members = Map::new();
        members.insert("id".to_owned(), Value::String(self.id.clone()));
        members.insert("sessionId".to_owned(), Value::String(self.session_id));
        members.insert("sequence".to_owned(), Value::from(self.sequence));
        members.insert("occurredAt".to_owned(), Value::String(self.occurred_at));
        members.insert("category".to_owned(), Value::String(self.category));
        members.insert("type".to_owned(), Value::String(self.event_type));
        members.insert(
            "actor".to_owned(),
            self.actor.map_or(Value::Null, Value::String),
        );
        members.insert("payload".to_owned(), payload);
        if let Some(correlation_id) = self.correlation_id {
            members.insert("correlationId".to_owned(), Value::String(correlation_id));
        }
        if let Some(causation_id) = self.causation_id {
            members.insert("causationId".to_owned(), Value::String(causation_id));
        }
        members.insert("version".to_owned(), Value::String(self.version));
        let envelope: EventEnvelope = serde_json::from_value(Value::Object(members))
            .map_err(|error| malformed(MalformedStoredEventFault::NotAnEnvelope(error)))?;
        envelope
            .validate()
            .map_err(|report| malformed(MalformedStoredEventFault::Check(report)))?;
        Ok(envelope)
    }
}
