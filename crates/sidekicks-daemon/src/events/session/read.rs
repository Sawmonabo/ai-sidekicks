//! The `session_events` reads, run on the daemon's read-only connection: a session's head, the rows
//! after a log position, of every type or of named types, one run's rows after a position with
//! their stored bodies, the rows up to one, the rows of a sequence window and the rows at named
//! sequences, each in sequence order, one row by its event id with its stored body, and the check
//! of a cursor against the head. A row crosses in from the database file, so each one is checked
//! against the envelope contract on the way out. A range the session skipped past as damaged is
//! never read, and while its history is damaged no read goes past its last good point.

use std::sync::LazyLock;

use garde::Validate as _;
use rusqlite::{Connection, OptionalExtension, Row, named_params, params};
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

use crate::events::content::read::{StoredEventContentRow, hydrate_stored_event};
use crate::events::session::skipped_ranges::outside_skipped_ranges_sql;

/// A stored event row that is not a well-formed event envelope, which only a write outside the
/// append path can leave; it names the row by its stored event id, session id and sequence.
#[derive(Debug, thiserror::Error)]
#[error(
    "the stored event {event_id} of session {session_id} at sequence {sequence} is not a \
     well-formed event, so the row was written outside the append path"
)]
pub(crate) struct MalformedStoredEventError {
    /// The row's event id, as stored.
    pub(crate) event_id: String,
    /// The row's session id, as stored.
    pub(crate) session_id: String,
    /// The row's sequence.
    pub(crate) sequence: i64,
    /// What is wrong with it.
    #[source]
    pub(crate) fault: MalformedStoredEventFault,
}

/// What makes a stored row not a well-formed event envelope.
#[derive(Debug, thiserror::Error)]
pub(crate) enum MalformedStoredEventFault {
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

// One run's readable rows of the given types after a position, through the event log's
// run-and-type index, each with its stored body, in sequence order.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the provider switch's hand-over brief")
)]
static RUN_AFTER_OF_TYPES_HYDRATED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {SELECTED_COLUMNS}, content_payload
       FROM session_events AS event
      WHERE session_id = @session_id AND run_id = @run_id AND sequence > @after_position
        AND type IN (SELECT value FROM json_each(@event_types))
        AND {}
      ORDER BY sequence ASC",
        readable_event_sql("event")
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
            .query_row([session_id.text().as_str()], |row| row.get(0))?;
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
                params![session_id.text().as_str(), after_position, before, limit],
            ),
            Some(event_types) => self.read_rows(
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

    /// Every event of run `run_id` of one of `event_types` with a sequence greater than
    /// `after_position` and, where `before_sequence` is given, below it, each paired with its
    /// stored body.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the provider switch's hand-over brief")
    )]
    pub(crate) fn read_after_hydrated(
        &self,
        session_id: &SessionId,
        run_id: &RunId,
        after_position: i64,
        event_types: &[&str],
        before_sequence: Option<i64>,
    ) -> Result<Vec<HydratedSessionEvent>, SessionLogReadError> {
        let read_bound = self.read_bound(session_id, before_sequence);
        self.read_hydrated_rows(
            &RUN_AFTER_OF_TYPES_HYDRATED_SQL,
            named_params! {
                "@session_id": session_id.text().as_str(),
                "@run_id": run_id.text().as_str(),
                "@after_position": after_position,
                "@event_types": serde_json::to_string(event_types)
                    .expect("a list of strings serializes"),
                "@read_bound": read_bound,
            },
        )
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
                session_id.text().as_str(),
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
                session_id.text().as_str(),
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
                session_id.text().as_str(),
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
                    session_id.text().as_str(),
                    event_id,
                    self.read_bound(session_id, None)
                ],
                StoredEventRow::from_row_with_content,
            )
            .optional()?;
        Ok(stored
            .map(|(row, content_payload)| row.into_content_row(content_payload))
            .transpose()?)
    }

    fn read_bound(&self, session_id: &SessionId, before_sequence: Option<i64>) -> i64 {
        session_read_bound(
            &self.read_damaged_from_sequence,
            session_id,
            before_sequence,
        )
    }

    /// Runs one of the statements that select a row's body after its columns, checks each row as
    /// an envelope and pairs it with its body, in the order read.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the provider switch's hand-over brief")
    )]
    fn read_hydrated_rows(
        &self,
        sql: &str,
        bindings: impl rusqlite::Params,
    ) -> Result<Vec<HydratedSessionEvent>, SessionLogReadError> {
        let mut statement = self.reader.prepare_cached(sql)?;
        let mut rows = statement.query(bindings)?;
        let mut events = Vec::new();
        while let Some(row) = rows.next()? {
            let (stored, content_payload) = StoredEventRow::from_row_with_content(row)?;
            events.push(hydrate_stored_event(
                stored.into_content_row(content_payload)?,
            ));
        }
        Ok(events)
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
/// later commit. Fails with [`SessionEventCursorUnresolvable`] for a cursor that names no position
/// or one past the head.
pub(crate) fn resolve_event_cursor(
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
            payload: serde_json::from_str(row.get_ref(7)?.as_str()?),
            correlation_id: row.get(8)?,
            causation_id: row.get(9)?,
            version: row.get(10)?,
        })
    }

    /// The row and the stored body a statement selects after its columns.
    fn from_row_with_content(row: &Row<'_>) -> rusqlite::Result<(Self, Option<Vec<u8>>)> {
        Ok((
            Self::from_row(row)?,
            row.get::<_, Option<Vec<u8>>>(STORED_EVENT_COLUMN_COUNT)?,
        ))
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

    /// The row as an envelope beside its stored body, the UTF-8 bytes `content_payload` holds;
    /// fails as [`StoredEventRow::into_envelope`] does, and on a body that is not UTF-8.
    fn into_content_row(
        self,
        content_payload: Option<Vec<u8>>,
    ) -> Result<StoredEventContentRow, MalformedStoredEventError> {
        let envelope = self.into_envelope()?;
        let content_payload =
            content_payload
                .map(String::from_utf8)
                .transpose()
                .map_err(|error| MalformedStoredEventError {
                    event_id: envelope.id.as_str().to_owned(),
                    session_id: envelope.session_id.text().as_str().to_owned(),
                    sequence: i64::from(envelope.sequence),
                    fault: column_fault("content_payload", Some(error)),
                })?;
        Ok(StoredEventContentRow {
            envelope,
            content_payload,
        })
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
mod tests {
    use rstest::rstest;
    use rusqlite::params;
    use sidekicks_contracts::session::id::SessionId;

    use super::{MalformedStoredEventFault, SessionEventReads, SessionLogReadError};
    use crate::database::writer::test_file::{TestDatabase, test_session_id};
    use sidekicks_contracts::wire::id::mint_uuid_v7;

    const WELL_FORMED_INSTANT: &str = "2026-10-14T09:00:00.000Z";

    #[rstest]
    #[case::payload_not_an_object(WELL_FORMED_INSTANT, "sessionLifecycle", "[]", "payload")]
    #[case::prototype_member(
        WELL_FORMED_INSTANT,
        "sessionLifecycle",
        r#"{"__proto__":{}}"#,
        "__proto__"
    )]
    #[case::occurred_at_finer_than_a_millisecond(
        "2026-10-14T09:00:00.0001Z",
        "sessionLifecycle",
        "{}",
        "occurred_at"
    )]
    #[case::unknown_category(WELL_FORMED_INSTANT, "lifecycle", "{}", "category")]
    fn a_malformed_stored_row_is_refused_naming_its_event_and_session(
        #[case] occurred_at: &str,
        #[case] category: &str,
        #[case] payload: &str,
        #[case] faulty_member: &str,
    ) {
        let database = TestDatabase::new();
        let writer = database.opener()().expect("the test creates its database");
        let (session_id, event_id) = (test_session_id(), mint_uuid_v7().to_string());
        writer
            .execute(
                "INSERT INTO session_events
                   (id, session_id, sequence, occurred_at, monotonic_ns, category, type, payload)
                 VALUES (?1, ?2, 0, ?3, 0, ?4, 'session.pinned', ?5)",
                params![
                    event_id,
                    session_id.text().as_str(),
                    occurred_at,
                    category,
                    payload
                ],
            )
            .expect("the test writes its row");

        let reader = database.reader();
        let reads = SessionEventReads::new(&reader, |_: &SessionId| None);
        let Err(SessionLogReadError::Malformed(malformed)) = reads.read_window(&session_id, 0, 0)
        else {
            panic!("the row is refused as malformed");
        };
        let found_member = match &malformed.fault {
            MalformedStoredEventFault::PayloadNotObject(_) => "payload",
            MalformedStoredEventFault::PrototypeMember => "__proto__",
            MalformedStoredEventFault::Column { column, .. } => column,
            MalformedStoredEventFault::Check(_) => "check",
        };
        assert_eq!(found_member, faulty_member);
        assert_eq!(malformed.event_id, event_id);
        assert_eq!(malformed.session_id, session_id.text().as_str());
        let message = malformed.to_string();
        assert!(message.contains(&event_id), "{message}");
        assert!(message.contains(session_id.text().as_str()), "{message}");
    }
}
