//! The `session_events` reads, run on the daemon's read-only connection: a session's head, the rows
//! after a log position, of every type or of named types, one run's rows after a position with
//! their stored bodies, the rows up to one, the rows of a sequence window and the rows at named
//! sequences, each in sequence order, one row by its event id with its stored body, and the check
//! of a cursor against the head. A row crosses in from the database file, so each one is checked
//! against the envelope contract on the way out. A range the session skipped past as damaged is
//! never read, and while its history is damaged no read goes past its last good point. A stored
//! part of a tool completion's patched files is no event, so no read of events takes it.

use std::sync::LazyLock;

use garde::Validate as _;
use rusqlite::types::Type;
use rusqlite::{Connection, OptionalExtension as _, Row, Transaction, ffi, named_params, params};
use serde_json::{Map, Value};
use sidekicks_contracts::event::envelope::{
    EventCategory, EventEnvelope, EventEnvelopeType, EventOccurredAt, HydratedSessionEvent,
};
use sidekicks_contracts::event::version::{EVENT_FIELD_MAX_LEN, EventEnvelopeVersion};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::event_cursor::{
    EventCursor, START_OF_LOG_POSITION, SessionEventCursorUnresolvable, decode_event_cursor,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::{MAX_SAFE_SIGNED_INTEGER, SafeInt};
use sidekicks_contracts::wire::record::RecordKey;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::events::content::codec::{
    BodyStreamError, StoredBodyPlace, out_of_memory_read_failure, stored_body_place_sql,
};
use crate::events::content::read::{
    StoredEventContentRow, hydrate_stored_event, joined_content_length,
};
use crate::events::session::skipped_ranges::outside_skipped_ranges_sql;
use crate::transcript_rejoin::{row_condition_sql, stored_patch_part_sql};

/// A stored event row that is not a well-formed event envelope, which only a write outside the
/// append path can leave; it names the row by its stored event id, session id and sequence.
#[derive(Debug, thiserror::Error)]
#[error(
    "the stored event {event_id} of session {session_id} at sequence {sequence} is not a \
     well-formed event, so the row was written outside the append path"
)]
pub struct MalformedStoredEventError {
    /// The row's event id, as stored.
    pub event_id: String,
    /// The row's session id, as stored.
    pub session_id: String,
    /// The row's sequence.
    pub sequence: i64,
    /// What is wrong with it.
    #[source]
    pub fault: MalformedStoredEventFault,
}

/// What makes a stored row not a well-formed event envelope.
#[derive(Debug, thiserror::Error)]
pub enum MalformedStoredEventFault {
    /// `session_events.payload` is not a JSON object.
    #[error("its payload column is not a JSON object")]
    PayloadNotObject(#[source] serde_json::Error),
    /// The payload holds the member `__proto__`, which no reader may meet.
    #[error("its payload holds the member __proto__")]
    PrototypeMember,
    /// A column does not hold its envelope member's form.
    #[error("its {column} column does not hold an envelope's {column}")]
    Column {
        /// The column's name.
        column: &'static str,
        /// Why the value was refused, where its check says.
        #[source]
        cause: Option<Box<dyn std::error::Error + Send + Sync>>,
    },
    /// The envelope breaks one of its checks.
    #[error("its envelope breaks one of the envelope's checks")]
    Check(#[source] garde::Report),
}

/// Why a read of a session's log failed.
#[derive(Debug, thiserror::Error)]
pub enum SessionLogReadError {
    /// SQLite refused the read, or a column holds a type its schema forbids.
    #[error("a session_events read failed")]
    Database(#[from] rusqlite::Error),
    /// A row is not a well-formed event envelope.
    #[error(transparent)]
    Malformed(#[from] MalformedStoredEventError),
}

/// Which of the events after a position a read takes; every one when a member is `None`.
#[derive(Clone, Copy, Debug, Default)]
pub struct SessionEventFilter<'types> {
    /// Only events of these types.
    pub event_types: Option<&'types [&'types str]>,
    /// Only events before this sequence.
    pub before_sequence: Option<i64>,
}

/// The envelope's columns, in the order [`SessionEventReads::read_envelopes`] reads them; a
/// statement naming them reads its rows' table as `event`.
pub const SELECTED_COLUMNS: &str = "event.id, event.session_id, event.sequence, \
     event.occurred_at, event.category, event.type, event.actor, event.payload, \
     event.correlation_id, event.causation_id, event.version";

// The bound of a read that has none: no session's log reaches this sequence.
const NO_SEQUENCE_BOUND: i64 = MAX_SAFE_SIGNED_INTEGER;

const HEAD_SQL: &str = "SELECT MAX(sequence) FROM session_events WHERE session_id = ?";

static AFTER_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {SELECTED_COLUMNS}
       FROM session_events AS event
      WHERE session_id = ? AND sequence > ? AND sequence < ?
        AND {} AND NOT {}
      ORDER BY sequence ASC
      LIMIT ?",
        outside_skipped_ranges_sql("event"),
        stored_patch_part_sql("event"),
    )
});

static AFTER_OF_TYPES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {SELECTED_COLUMNS}
       FROM session_events AS event
      WHERE session_id = ? AND sequence > ? AND sequence < ?
        AND type IN (SELECT value FROM json_each(?))
        AND {} AND NOT {}
      ORDER BY sequence ASC
      LIMIT ?",
        outside_skipped_ranges_sql("event"),
        stored_patch_part_sql("event"),
    )
});

static WINDOW_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {SELECTED_COLUMNS}
       FROM session_events AS event
      WHERE session_id = ? AND sequence BETWEEN ? AND ? AND sequence < ?
        AND {} AND NOT {}
      ORDER BY sequence ASC",
        outside_skipped_ranges_sql("event"),
        stored_patch_part_sql("event"),
    )
});

static AT_SEQUENCES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {SELECTED_COLUMNS}
       FROM session_events AS event
      WHERE session_id = ? AND sequence IN (SELECT value FROM json_each(?)) AND sequence < ?
        AND {} AND NOT {}
      ORDER BY sequence ASC",
        outside_skipped_ranges_sql("event"),
        stored_patch_part_sql("event"),
    )
});

// A page of a run's rows of the given types, each once per stored body it joins: its own and those
// of the readable pieces that join it after it, in log order, or once with no body when none has
// one; each body is selected by its place, never loaded. The page is the run's first `@limit` rows
// after `@after_position`.
static RUN_PAGE_HYDRATED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {SELECTED_COLUMNS}, {member_body}
       FROM session_events AS event
       LEFT JOIN session_events AS member
         ON member.session_id = event.session_id
        AND (member.sequence = event.sequence
          OR (member.joins_sequence = coalesce(event.joins_sequence, event.sequence)
              AND member.sequence > event.sequence))
        AND member.content_payload IS NOT NULL
        AND {readable_member}
      WHERE event.session_id = @session_id
        AND event.sequence IN (
          SELECT page.sequence FROM session_events AS page
           WHERE page.session_id = @session_id AND page.run_id = @run_id
             AND page.sequence > @after_position
             AND page.type IN (SELECT value FROM json_each(@event_types))
             AND {readable_page} AND {page_row}
           ORDER BY page.sequence ASC
           LIMIT @limit)
      ORDER BY event.sequence ASC, member.sequence ASC",
        member_body = stored_body_place_sql("member"),
        readable_member = readable_event_sql("member"),
        readable_page = readable_event_sql("page"),
        page_row = row_condition_sql("page"),
    )
});

// A page of a session's rows, every type and run, each once per stored body it joins as
// RUN_PAGE_HYDRATED_SQL joins them; the page is its first `@limit` rows after `@after_position`.
static SESSION_PAGE_HYDRATED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {SELECTED_COLUMNS}, {member_body}
       FROM session_events AS event
       LEFT JOIN session_events AS member
         ON member.session_id = event.session_id
        AND (member.sequence = event.sequence
          OR (member.joins_sequence = coalesce(event.joins_sequence, event.sequence)
              AND member.sequence > event.sequence))
        AND member.content_payload IS NOT NULL
        AND {readable_member}
      WHERE event.session_id = @session_id
        AND event.sequence IN (
          SELECT page.sequence FROM session_events AS page
           WHERE page.session_id = @session_id AND page.sequence > @after_position
             AND {readable_page} AND {page_row}
           ORDER BY page.sequence ASC
           LIMIT @limit)
      ORDER BY event.sequence ASC, member.sequence ASC",
        member_body = stored_body_place_sql("member"),
        readable_member = readable_event_sql("member"),
        readable_page = readable_event_sql("page"),
        page_row = row_condition_sql("page"),
    )
});

/// The most rows one hydrated page holds.
const HYDRATED_PAGE_ROWS: i64 = 64;

/// The most text, in UTF-8 bytes as the payloads state it, one hydrated page loads: 8 MiB, so a
/// reader holds a few pages of text at most whatever the bodies' sizes, and an export, which holds
/// one page at a time, stays within its 64 MiB budget.
pub const HYDRATED_PAGE_TEXT_BYTES: u64 = 8 * 1024 * 1024;

/// One page of hydrated rows: the rows whose bodies together stay within
/// [`HYDRATED_PAGE_TEXT_BYTES`], loaded, and, when the next row's body alone passes it, that row
/// unloaded, for its reader to take a frame at a time or load by itself.
#[derive(Debug, Default)]
pub struct HydratedPage {
    /// The rows loaded, in log order.
    pub events: Vec<HydratedSessionEvent>,
    /// The row after them whose body alone passes the page's text, unloaded.
    pub oversized: Option<UnloadedBodyEvent>,
}

impl HydratedPage {
    /// The sequence of the page's last row, loaded or not; `None` for an empty page, which ends
    /// the read.
    pub fn last_sequence(&self) -> Option<i64> {
        self.oversized
            .as_ref()
            .map(|unloaded| &unloaded.event)
            .or_else(|| self.events.last().map(|event| &event.event))
            .map(|event| i64::from(event.sequence))
    }
}

/// A row whose body is too long to load with others: the event and where each stored piece of its
/// body sits, in order.
#[derive(Debug)]
pub struct UnloadedBodyEvent {
    /// The event, checked as an envelope.
    pub event: EventEnvelope,
    /// Its own body's place, then those of the pieces that join it.
    pub pieces: Vec<StoredBodyPlace>,
}

static EVENT_BY_ID_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {SELECTED_COLUMNS}
       FROM session_events AS event
      WHERE session_id = ? AND id = ? AND sequence < ?
        AND {} AND NOT {}",
        outside_skipped_ranges_sql("event"),
        stored_patch_part_sql("event"),
    )
});

// The session's first row whose payload SQLite's JSON functions cannot read, which makes any of
// them that reads it fail the statement without naming the row.
const UNREADABLE_PAYLOAD_SQL: &str = "SELECT id, sequence, payload FROM session_events
  WHERE session_id = ?1 AND json_error_position(payload) <> 0
  ORDER BY sequence LIMIT 1";

/// `error`, the failure of a read of `session_id` on `reader` whose statement runs a JSON function
/// over stored payloads, as the damaged row it met: the session's first row whose payload is no
/// JSON, as a conversion failure of the payload column carrying its [`MalformedStoredEventError`].
/// Answers `error` itself when it is not SQLite's generic error, which a JSON function raises,
/// when every payload reads, or when the search for the row fails.
pub fn payload_damage_of(
    reader: &Connection,
    session_id: &SessionId,
    error: rusqlite::Error,
) -> rusqlite::Error {
    // A JSON function's refusal of a payload is SQLite's generic error; a busy, locked,
    // interrupted, corrupt or failed read of the file is no damaged row and passes through.
    if !matches!(
        &error,
        rusqlite::Error::SqliteFailure(failure, _) if failure.extended_code == ffi::SQLITE_ERROR
    ) {
        return error;
    }
    let unreadable = reader
        .prepare_cached(UNREADABLE_PAYLOAD_SQL)
        .and_then(|mut statement| {
            statement
                .query_row([session_id.text().as_str()], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .optional()
        });
    let Ok(Some((event_id, sequence, payload))) = unreadable else {
        return error;
    };
    // Text SQLite cannot read as JSON is no JSON serde reads either.
    let Err(fault) = serde_json::from_str::<Map<String, Value>>(&payload) else {
        return error;
    };
    rusqlite::Error::FromSqlConversionFailure(
        PAYLOAD_COLUMN,
        Type::Text,
        Box::new(MalformedStoredEventError {
            event_id,
            session_id: session_id.text().as_str().to_owned(),
            sequence,
            fault: MalformedStoredEventFault::PayloadNotObject(fault),
        }),
    )
}

/// Answers the sequence a damaged session's reads stop before, `None` for a session that reads
/// whole.
pub type DamagedFromSequenceReader = dyn Fn(&SessionId) -> Option<i64> + Send + Sync;

/// Whether the event aliased `event_alias` is one the log can read: before `@read_bound`, which
/// [`session_read_bound`] gives, and outside every range its session skipped as damaged.
pub fn readable_event_sql(event_alias: &str) -> String {
    format!(
        "{event_alias}.sequence < @read_bound AND {}",
        outside_skipped_ranges_sql(event_alias)
    )
}

/// The sequence a read of `session_id` stops before: the earlier of the read's own
/// `before_sequence` and the session's last good point while its history is damaged, which
/// `read_damaged_from_sequence` answers, else past every sequence.
pub fn session_read_bound(
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
pub struct SessionEventReads<'reader, DamagedFrom> {
    reader: &'reader Connection,
    read_damaged_from_sequence: DamagedFrom,
}

impl<'reader, DamagedFrom> SessionEventReads<'reader, DamagedFrom>
where
    DamagedFrom: Fn(&SessionId) -> Option<i64>,
{
    /// The reads on `reader`; `read_damaged_from_sequence` answers the sequence a damaged
    /// session's reads stop before, `None` for a session that reads whole.
    pub fn new(reader: &'reader Connection, read_damaged_from_sequence: DamagedFrom) -> Self {
        Self {
            reader,
            read_damaged_from_sequence,
        }
    }

    /// A read transaction on the reads' connection, so every read made while it is held sees one
    /// snapshot of the store; fails when SQLite refuses to begin it.
    pub fn snapshot(&self) -> rusqlite::Result<Transaction<'reader>> {
        self.reader.unchecked_transaction()
    }

    /// The session's highest sequence it reads to, below its last good point while its history is
    /// damaged, or `None` when it has no such event.
    pub fn read_head(&self, session_id: &SessionId) -> Result<Option<i64>, SessionLogReadError> {
        let head: Option<i64> = self
            .reader
            .prepare_cached(HEAD_SQL)?
            .query_row([session_id.text().as_str()], |row| row.get(0))?;
        Ok(head
            .map(|head| head.min(self.read_bound(session_id, None) - 1))
            .filter(|&read_to| read_to >= 0))
    }

    /// Up to `limit` events with a sequence greater than `after_position`, every one when `limit`
    /// is negative, and only those `filter` takes.
    pub fn read_after(
        &self,
        session_id: &SessionId,
        after_position: i64,
        limit: i64,
        filter: SessionEventFilter<'_>,
    ) -> Result<Vec<EventEnvelope>, SessionLogReadError> {
        let before = self.read_bound(session_id, filter.before_sequence);
        match filter.event_types {
            None => self.read_envelopes(
                &AFTER_SQL,
                params![session_id.text().as_str(), after_position, before, limit],
            ),
            Some(event_types) => self.read_envelopes(
                &AFTER_OF_TYPES_SQL,
                params![
                    session_id.text().as_str(),
                    after_position,
                    before,
                    serde_json::to_string(event_types).expect("a list of strings serializes"),
                    limit
                ],
            ),
        }
    }

    /// A page of run `run_id`'s rows of one of `event_types` with a sequence greater than
    /// `after_position` and, where `before_sequence` is given, below it, each paired with its body:
    /// its own stored body joined with those of the pieces that continue it, below the same bound.
    pub fn read_run_page_hydrated(
        &self,
        session_id: &SessionId,
        run_id: &RunId,
        after_position: i64,
        event_types: &[&str],
        before_sequence: Option<i64>,
    ) -> Result<HydratedPage, SessionLogReadError> {
        let read_bound = self.read_bound(session_id, before_sequence);
        self.read_hydrated_page(
            &RUN_PAGE_HYDRATED_SQL,
            named_params! {
                "@session_id": session_id.text().as_str(),
                "@run_id": run_id.text().as_str(),
                "@after_position": after_position,
                "@event_types": serde_json::to_string(event_types)
                    .expect("a list of strings serializes"),
                "@read_bound": read_bound,
                "@limit": HYDRATED_PAGE_ROWS,
            },
        )
    }

    /// A page of the session's rows after `after_position`, of every type and run, each paired
    /// with its body as [`Self::read_run_page_hydrated`] pairs it.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the data export writes every session's rows")
    )]
    pub fn read_page_hydrated(
        &self,
        session_id: &SessionId,
        after_position: i64,
    ) -> Result<HydratedPage, SessionLogReadError> {
        let read_bound = self.read_bound(session_id, None);
        self.read_hydrated_page(
            &SESSION_PAGE_HYDRATED_SQL,
            named_params! {
                "@session_id": session_id.text().as_str(),
                "@after_position": after_position,
                "@read_bound": read_bound,
                "@limit": HYDRATED_PAGE_ROWS,
            },
        )
    }

    /// `unloaded`'s row paired with its body loaded whole. Fails as a hydrated page does.
    pub fn load_body(
        &self,
        unloaded: UnloadedBodyEvent,
    ) -> Result<HydratedSessionEvent, SessionLogReadError> {
        self.hydrate_pieces(unloaded.event, &unloaded.pieces)
    }

    /// The events with a sequence from `from_sequence` to `to_sequence`, both included.
    pub fn read_window(
        &self,
        session_id: &SessionId,
        from_sequence: i64,
        to_sequence: i64,
    ) -> Result<Vec<EventEnvelope>, SessionLogReadError> {
        self.read_envelopes(
            &WINDOW_SQL,
            params![
                session_id.text().as_str(),
                from_sequence,
                to_sequence,
                self.read_bound(session_id, None)
            ],
        )
    }

    /// The events at the given sequences; a sequence the session holds no event at reads none.
    pub fn read_at_sequences(
        &self,
        session_id: &SessionId,
        sequences: &[i64],
    ) -> Result<Vec<EventEnvelope>, SessionLogReadError> {
        self.read_envelopes(
            &AT_SEQUENCES_SQL,
            params![
                session_id.text().as_str(),
                serde_json::to_string(sequences).expect("a list of integers serializes"),
                self.read_bound(session_id, None)
            ],
        )
    }

    /// The event `event_id`, without its body, or `None` when the session reads none.
    pub fn read_event(
        &self,
        session_id: &SessionId,
        event_id: &str,
    ) -> Result<Option<EventEnvelope>, SessionLogReadError> {
        Ok(self
            .read_envelopes(
                &EVENT_BY_ID_SQL,
                params![
                    session_id.text().as_str(),
                    event_id,
                    self.read_bound(session_id, None)
                ],
            )?
            .pop())
    }

    /// The sequence a read of `session_id` stops before, as [`session_read_bound`] answers it.
    pub fn read_bound(&self, session_id: &SessionId, before_sequence: Option<i64>) -> i64 {
        session_read_bound(
            &self.read_damaged_from_sequence,
            session_id,
            before_sequence,
        )
    }

    /// Runs one of the statements that select a row once per stored body it joins, those places
    /// after its own columns, and checks each row as an envelope. Rows are taken in order while
    /// their bodies' stated lengths stay within [`HYDRATED_PAGE_TEXT_BYTES`]; the statement is
    /// stepped no further than the row that passes it, which comes back unloaded when it is the
    /// first. Only then are the taken rows' bodies loaded and joined.
    fn read_hydrated_page(
        &self,
        sql: &str,
        bindings: impl rusqlite::Params,
    ) -> Result<HydratedPage, SessionLogReadError> {
        let mut taken: Vec<(EventEnvelope, Vec<StoredBodyPlace>)> = Vec::new();
        let mut oversized = None;
        {
            let mut statement = self.reader.prepare_cached(sql)?;
            let mut rows = statement.query(bindings)?;
            let mut text_bytes: u64 = 0;
            let mut held: Option<(StoredEventRow, Vec<StoredBodyPlace>)> = None;
            loop {
                let next = match rows.next()? {
                    Some(row) => Some((
                        StoredEventRow::from_row(row)?,
                        StoredBodyPlace::read(row, STORED_EVENT_COLUMN_COUNT)?,
                    )),
                    None => None,
                };
                if let (Some((event, pieces)), Some((stored, piece))) = (&mut held, &next)
                    && event.sequence == stored.sequence
                {
                    pieces.extend(piece.clone());
                    continue;
                }
                if let Some((event, pieces)) = held.take() {
                    let body_bytes: u64 = pieces
                        .iter()
                        .map(|piece| piece.content_length.unwrap_or(0))
                        .sum();
                    if text_bytes + body_bytes > HYDRATED_PAGE_TEXT_BYTES {
                        if taken.is_empty() {
                            oversized = Some(UnloadedBodyEvent {
                                event: event.into_envelope()?,
                                pieces,
                            });
                        }
                        break;
                    }
                    text_bytes += body_bytes;
                    taken.push((event.into_envelope()?, pieces));
                }
                let Some((stored, piece)) = next else { break };
                held = Some((stored, piece.into_iter().collect()));
            }
        }
        let events = taken
            .into_iter()
            .map(|(envelope, pieces)| self.hydrate_pieces(envelope, &pieces))
            .collect::<Result<Vec<_>, SessionLogReadError>>()?;
        Ok(HydratedPage { events, oversized })
    }

    /// `envelope` paired with the text of `pieces`, the stored pieces of its body, decoded and
    /// joined in order, unavailable when there are none. Fails with
    /// [`SessionLogReadError::Malformed`] on a piece that does not decode to the length its
    /// payload states.
    fn hydrate_pieces(
        &self,
        envelope: EventEnvelope,
        pieces: &[StoredBodyPlace],
    ) -> Result<HydratedSessionEvent, SessionLogReadError> {
        let mut content_payload: Option<String> = None;
        for piece in pieces {
            let text = piece
                .decode(self.reader)
                .map_err(|error| body_read_error(&envelope, error))?;
            content_payload.get_or_insert_default().push_str(&text);
        }
        Ok(hydrate_stored_event(StoredEventContentRow {
            envelope,
            content_payload,
            content_length: joined_content_length(pieces),
        }))
    }

    /// Runs a statement selecting [`SELECTED_COLUMNS`] and checks each row as an envelope, in the
    /// order read.
    pub fn read_envelopes(
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
/// later commit. Fails with [`SessionEventCursorUnresolvable`] for a cursor that names no position
/// or one past the head.
pub fn resolve_event_cursor(
    cursor: Option<&EventCursor>,
    head: Option<i64>,
) -> Result<i64, SessionEventCursorUnresolvable> {
    let Some(cursor) = cursor else {
        return Ok(START_OF_LOG_POSITION);
    };
    let position = decode_event_cursor(cursor)?;
    if position > head.unwrap_or(START_OF_LOG_POSITION) {
        return Err(SessionEventCursorUnresolvable);
    }
    Ok(position)
}

// The columns `SELECTED_COLUMNS` names; a stored-row read's body column follows them.
const STORED_EVENT_COLUMN_COUNT: usize = 11;

// The payload's place among `SELECTED_COLUMNS`.
const PAYLOAD_COLUMN: usize = 7;

/// A `session_events` row as the reads select it, before it is checked; its payload is parsed
/// straight from the column's text.
struct StoredEventRow {
    id: String,
    session_id: String,
    sequence: i64,
    occurred_at: String,
    category: String,
    event_type: String,
    actor: Option<String>,
    payload: Result<Map<String, Value>, serde_json::Error>,
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
            payload: serde_json::from_str(row.get_ref(PAYLOAD_COLUMN)?.as_str()?),
            correlation_id: row.get(8)?,
            causation_id: row.get(9)?,
            version: row.get(10)?,
        })
    }

    /// The row as an envelope, each column through its member's own check, then the envelope's
    /// checks; a type this build does not know is kept as a stub. Storage keeps an absent
    /// correlation or causation id, and an absent actor, as NULL.
    fn into_envelope(self) -> Result<EventEnvelope, MalformedStoredEventError> {
        let sequence = self.sequence;
        let malformed = |fault| MalformedStoredEventError {
            event_id: self.id.clone(),
            session_id: self.session_id.clone(),
            sequence,
            fault,
        };
        let payload = self
            .payload
            .map_err(|error| malformed(MalformedStoredEventFault::PayloadNotObject(error)))?;
        if payload.keys().any(RecordKey::is_prototype_key) {
            return Err(malformed(MalformedStoredEventFault::PrototypeMember));
        }
        let envelope = EventEnvelope {
            id: event_text(self.id.clone(), "id").map_err(malformed)?,
            session_id: SessionId::new(&self.session_id)
                .map_err(|error| malformed(column_fault("session_id", Some(error))))?,
            sequence: u64::try_from(sequence)
                .ok()
                .and_then(SafeInt::new)
                .ok_or_else(|| malformed(column_fault::<TextOnly>("sequence", None)))?,
            occurred_at: EventOccurredAt::new(self.occurred_at)
                .map_err(|refusal| malformed(column_fault("occurred_at", Some(refusal))))?,
            category: EventCategory::from_wire_name(&self.category)
                .ok_or_else(|| malformed(column_fault::<TextOnly>("category", None)))?,
            event_type: EventEnvelopeType(event_text(self.event_type, "type").map_err(malformed)?),
            actor: Some(
                self.actor
                    .map(|actor| event_text(actor, "actor"))
                    .transpose()
                    .map_err(malformed)?,
            ),
            payload,
            correlation_id: self
                .correlation_id
                .map(|correlation_id| event_text(correlation_id, "correlation_id"))
                .transpose()
                .map_err(malformed)?,
            causation_id: self
                .causation_id
                .map(|causation_id| event_text(causation_id, "causation_id"))
                .transpose()
                .map_err(malformed)?,
            version: EventEnvelopeVersion::new(self.version)
                .ok_or_else(|| malformed(column_fault::<TextOnly>("version", None)))?,
        };
        envelope
            .validate()
            .map_err(|report| malformed(MalformedStoredEventFault::Check(report)))?;
        Ok(envelope)
    }
}

// Why `envelope`'s body could not be read: a refused read, or zstd with no memory to decode it, is
// the database's failure; a body that does not read back as its payload describes is malformed.
fn body_read_error(envelope: &EventEnvelope, error: BodyStreamError) -> SessionLogReadError {
    match error {
        BodyStreamError::Read(error) => SessionLogReadError::Database(error),
        BodyStreamError::OutOfMemory => SessionLogReadError::Database(out_of_memory_read_failure()),
        damaged @ (BodyStreamError::Damaged(_) | BodyStreamError::Write(_)) => {
            malformed_body(envelope, damaged).into()
        }
    }
}

/// `envelope`'s body that does not read back as its payload describes, as the malformed row it is.
pub fn malformed_body(
    envelope: &EventEnvelope,
    error: BodyStreamError,
) -> MalformedStoredEventError {
    MalformedStoredEventError {
        event_id: envelope.id.as_str().to_owned(),
        session_id: envelope.session_id.text().as_str().to_owned(),
        sequence: i64::from(envelope.sequence),
        fault: column_fault("content_payload", Some(error)),
    }
}

/// A column whose check gives no cause of its own.
type TextOnly = std::convert::Infallible;

fn column_fault<Cause: std::error::Error + Send + Sync + 'static>(
    column: &'static str,
    cause: Option<Cause>,
) -> MalformedStoredEventFault {
    MalformedStoredEventFault::Column {
        column,
        cause: cause.map(|cause| Box::new(cause) as Box<dyn std::error::Error + Send + Sync>),
    }
}

/// `text` as one of the envelope's free-form members, read from `column`.
fn event_text(
    text: String,
    column: &'static str,
) -> Result<FreeFormText<EVENT_FIELD_MAX_LEN>, MalformedStoredEventFault> {
    FreeFormText::new(text).map_err(|error| column_fault(column, Some(error)))
}

#[cfg(test)]
mod tests;
