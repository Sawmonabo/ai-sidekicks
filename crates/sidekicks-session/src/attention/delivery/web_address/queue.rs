//! The web address's send queue: one row per message still to send, its body frozen when it was
//! picked up and when its next attempt is due. A row exists only while its delivery is `pending`,
//! and refers to that delivery, so whatever deletes the delivery, a session's purge or a workflow
//! run's delete, takes the row with it. The writes are statement sets that settle a delivery, each
//! raising the counts of the delivery's session while it is still pending, and the reads are what
//! the sender works from. A row or a pending delivery can outlive its entry, which a damaged
//! history's rebuild deletes without its delivery; the sender drops either at its pickup, and such
//! a row once it is due.

use std::sync::LazyLock;

use bytes::Bytes;
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension as _, Row};
use sidekicks_contracts::attention::{AttentionTrigger, AttentionWebAddressState};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_store::database::schema::SchemaPart;
use sidekicks_store::database::sql_list::sql_list_of;
use sidekicks_store::database::statement::{WriteStatement, text_binding};
use sidekicks_store::database::stored_column::optional_text_column;

use crate::attention::projection::{
    MACHINE_VERSION_BUMP_SQL, session_binding, statement, version_bump_sql,
};

/// The most messages that wait at once; a newer one past it gives up on the oldest.
pub(crate) const MAX_WAITING_MESSAGES: usize = 100;

static PENDING_STATE: LazyLock<&'static str> =
    LazyLock::new(|| <&'static str>::from(AttentionWebAddressState::Pending));

// Whether a message's moment still stands: a final state and a Notify step always do; a wait does
// while it is open and no later entry speaks for its moment; a message whose entry is gone never
// does.
static STANDING_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "entry.id IS NOT NULL
      AND (entry.trigger IN ({final_states})
           OR (entry.resolved_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM attention_entries AS later
                                WHERE later.moment_id = entry.moment_id AND later.id <> entry.id
                                  AND {later_sequence} > {entry_sequence})))",
        final_states = trigger_list(&[
            AttentionTrigger::RunCompleted,
            AttentionTrigger::RunFailed,
            AttentionTrigger::WorkflowNotify,
        ]),
        later_sequence = "(SELECT sequence FROM session_events WHERE id = later.source_event_id)",
        entry_sequence = "(SELECT sequence FROM session_events WHERE id = entry.source_event_id)",
    )
});

// Whether a message is the end of a session muted since it was decided.
static MUTED_END_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "entry.id IS NOT NULL AND entry.trigger IN ({ends}) AND session_row.muted_at IS NOT NULL",
        ends = trigger_list(&[AttentionTrigger::RunCompleted, AttentionTrigger::RunFailed]),
    )
});

// The pending deliveries with no message in the queue yet, oldest moment first, with whether each
// moment stands and is a muted session's end; one whose entry is gone reads with no session.
static UNQUEUED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT delivery.entry_id, entry.session_id, {standing}, {muted_end}
  FROM attention_deliveries AS delivery
  LEFT JOIN attention_entries AS entry ON entry.id = delivery.entry_id
  LEFT JOIN sessions AS session_row ON session_row.id = entry.session_id
 WHERE delivery.web_address_state = '{pending}'
   AND NOT EXISTS (SELECT 1 FROM attention_web_address_sends AS send
                    WHERE send.entry_id = delivery.entry_id)
 ORDER BY entry.created_at, entry.id",
        standing = *STANDING_SQL,
        muted_end = *MUTED_END_SQL,
        pending = *PENDING_STATE,
    )
});

// The messages waiting, oldest moment first, with whether each moment stands and is a muted
// session's end; one whose entry is gone reads with no session.
static WAITING_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT send.entry_id, entry.session_id, {standing}, {muted_end}
  FROM attention_web_address_sends AS send
  LEFT JOIN attention_entries AS entry ON entry.id = send.entry_id
  LEFT JOIN sessions AS session_row ON session_row.id = entry.session_id
 ORDER BY entry.created_at, entry.id",
        standing = *STANDING_SQL,
        muted_end = *MUTED_END_SQL,
    )
});

// The message due first at `@now`, with what its attempt reads of its moment: its attempts so far,
// whether its moment still stands and whether it is a muted session's end.
static NEXT_DUE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT send.entry_id, entry.session_id, send.body, delivery.web_address_attempt_count,
    {standing}, {muted_end}
  FROM attention_web_address_sends AS send
  JOIN attention_deliveries AS delivery ON delivery.entry_id = send.entry_id
  LEFT JOIN attention_entries AS entry ON entry.id = send.entry_id
  LEFT JOIN sessions AS session_row ON session_row.id = entry.session_id
 WHERE send.next_attempt_at <= @now
 ORDER BY send.next_attempt_at, entry.created_at, entry.id
 LIMIT 1",
        standing = *STANDING_SQL,
        muted_end = *MUTED_END_SQL,
    )
});

const EARLIEST_DUE_SQL: &str = "SELECT MIN(next_attempt_at) FROM attention_web_address_sends";

// Every pending delivery, queued or not, its entry's session `NULL` once the entry is gone.
static PENDING_DELIVERIES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT delivery.entry_id, entry.session_id
  FROM attention_deliveries AS delivery
  LEFT JOIN attention_entries AS entry ON entry.id = delivery.entry_id
 WHERE delivery.web_address_state = '{pending}'",
        pending = *PENDING_STATE,
    )
});

static INSERT_SEND_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO attention_web_address_sends (entry_id, body, next_attempt_at)
  SELECT entry_id, @body, @next_attempt_at FROM attention_deliveries
   WHERE entry_id = @entry_id AND web_address_state = '{pending}'
  ON CONFLICT (entry_id) DO NOTHING",
        pending = *PENDING_STATE,
    )
});

static BUMP_IF_PENDING_SQL: LazyLock<String> = LazyLock::new(|| {
    version_bump_sql(&format!(
        "EXISTS (SELECT 1 FROM attention_deliveries
          WHERE entry_id = @entry_id AND web_address_state = '{pending}')",
        pending = *PENDING_STATE,
    ))
});

// Settles a pending delivery, adding the attempt it ended on, if any, to its count.
static SETTLE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE attention_deliveries
    SET web_address_state = @state,
        web_address_attempt_count = web_address_attempt_count + @attempts
  WHERE entry_id = @entry_id AND web_address_state = '{pending}'",
        pending = *PENDING_STATE,
    )
});

static COUNT_ATTEMPT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE attention_deliveries SET web_address_attempt_count = web_address_attempt_count + 1
  WHERE entry_id = @entry_id AND web_address_state = '{pending}'",
        pending = *PENDING_STATE,
    )
});

const RESCHEDULE_SQL: &str =
    "UPDATE attention_web_address_sends SET next_attempt_at = @next_attempt_at
  WHERE entry_id = @entry_id";

const DELETE_SEND_SQL: &str = "DELETE FROM attention_web_address_sends WHERE entry_id = @entry_id";

const MACHINE_VERSION_SQL: &str = "SELECT version FROM attention_versions WHERE scope_key = ''";

/// The send queue's schema part, after the attention tables whose deliveries it refers to.
pub(crate) fn send_queue_schema_part() -> SchemaPart {
    SchemaPart::new(
        "attention_web_address_sends",
        "
-- A web-address message still to send: its body, frozen when it was picked up and sent unchanged
-- at every attempt, and when its next attempt is due. A row exists only while its delivery is
-- pending, and goes with the delivery.
CREATE TABLE attention_web_address_sends (
  entry_id         TEXT PRIMARY KEY
                   REFERENCES attention_deliveries(entry_id) ON DELETE CASCADE,
  body             BLOB NOT NULL,
  next_attempt_at  TEXT NOT NULL
) STRICT;
"
        .to_owned(),
    )
}

/// A delivery the queue names: its entry and the entry's session, whose counts its write raises.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct QueuedDelivery {
    /// The entry, whose id is also the message's `webhook-id`.
    pub(crate) entry_id: String,
    /// The entry's session, `None` once the entry is gone, when its write raises the machine's
    /// count alone.
    pub(crate) session_id: Option<SessionId>,
}

impl QueuedDelivery {
    fn of_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            entry_id: row.get(0)?,
            session_id: optional_text_column(row, 1, |text| SessionId::new(&text))?,
        })
    }
}

/// A pending delivery the pickup reads, queued or not, with what it reads of its moment.
pub(crate) struct PickupDelivery {
    /// Its delivery.
    pub(crate) delivery: QueuedDelivery,
    /// Whether its moment still stands, as [`DueMessage::is_standing`] reads it.
    pub(crate) is_standing: bool,
    /// Whether it is the end of a session muted since it was decided.
    pub(crate) is_muted_end: bool,
}

impl PickupDelivery {
    fn of_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            delivery: QueuedDelivery::of_row(row)?,
            is_standing: row.get(2)?,
            is_muted_end: row.get(3)?,
        })
    }
}

/// The message due first, with what its attempt reads of its moment.
pub(crate) struct DueMessage {
    /// Its delivery.
    pub(crate) delivery: QueuedDelivery,
    /// Its frozen body.
    pub(crate) body: Bytes,
    /// The attempts made so far.
    pub(crate) attempt_count: i64,
    /// Whether its moment still stands and its entry is there: a final state always does, a wait
    /// while it is open and no later entry speaks for its moment.
    pub(crate) is_standing: bool,
    /// Whether it is the end of a session muted since it was decided.
    pub(crate) is_muted_end: bool,
}

/// The pending deliveries no message waits for yet, oldest moment first, with whether each is
/// still to send.
pub(crate) fn read_unqueued(reader: &Connection) -> rusqlite::Result<Vec<PickupDelivery>> {
    read_pickup_deliveries(reader, &UNQUEUED_SQL)
}

/// The messages waiting, oldest moment first, with whether each is still to send.
pub(crate) fn read_waiting(reader: &Connection) -> rusqlite::Result<Vec<PickupDelivery>> {
    read_pickup_deliveries(reader, &WAITING_SQL)
}

/// Every pending delivery, queued or not.
pub(crate) fn read_pending(reader: &Connection) -> rusqlite::Result<Vec<QueuedDelivery>> {
    read_deliveries(reader, &PENDING_DELIVERIES_SQL)
}

/// The message due first at `now`, `None` while none is due.
pub(crate) fn read_next_due(
    reader: &Connection,
    now: &WireInstant,
) -> rusqlite::Result<Option<DueMessage>> {
    reader
        .prepare_cached(&NEXT_DUE_SQL)?
        .query_row([now.as_str()], |row| {
            Ok(DueMessage {
                delivery: QueuedDelivery::of_row(row)?,
                body: Bytes::from(row.get::<_, Vec<u8>>(2)?),
                attempt_count: row.get(3)?,
                is_standing: row.get(4)?,
                is_muted_end: row.get(5)?,
            })
        })
        .optional()
}

/// When the earliest waiting message is due, `None` while none waits.
pub(crate) fn read_earliest_due(reader: &Connection) -> rusqlite::Result<Option<String>> {
    reader
        .prepare_cached(EARLIEST_DUE_SQL)?
        .query_row([], |row| row.get(0))
}

/// The write that queues `delivery`'s message with its frozen `body`, due at `due_at`, while the
/// delivery is still pending.
pub(crate) fn queue_statement(
    delivery: &QueuedDelivery,
    body: Vec<u8>,
    due_at: &WireInstant,
) -> WriteStatement {
    statement(
        &INSERT_SEND_SQL,
        vec![
            text_binding("@entry_id", &delivery.entry_id),
            ("@body".into(), Value::Blob(body)),
            text_binding("@next_attempt_at", due_at.as_str()),
        ],
    )
}

/// The writes that settle `delivery` as `state` while it is still pending, adding the attempt it
/// ended on to its count when `is_attempt_ended`, and drop its message.
pub(crate) fn settle_statements(
    delivery: &QueuedDelivery,
    state: AttentionWebAddressState,
    is_attempt_ended: bool,
) -> Vec<WriteStatement> {
    vec![
        bump_if_pending(delivery),
        statement(
            &SETTLE_SQL,
            vec![
                text_binding("@entry_id", &delivery.entry_id),
                text_binding("@state", <&'static str>::from(state)),
                (
                    "@attempts".into(),
                    Value::Integer(i64::from(is_attempt_ended)),
                ),
            ],
        ),
        statement(
            DELETE_SEND_SQL,
            vec![text_binding("@entry_id", &delivery.entry_id)],
        ),
    ]
}

/// The writes that count `delivery`'s failed attempt and set its next one due at `due_at`.
pub(crate) fn retry_statements(
    delivery: &QueuedDelivery,
    due_at: &WireInstant,
) -> Vec<WriteStatement> {
    vec![
        bump_if_pending(delivery),
        statement(
            &COUNT_ATTEMPT_SQL,
            vec![text_binding("@entry_id", &delivery.entry_id)],
        ),
        statement(
            RESCHEDULE_SQL,
            vec![
                text_binding("@entry_id", &delivery.entry_id),
                text_binding("@next_attempt_at", due_at.as_str()),
            ],
        ),
    ]
}

/// The read, inside a write, of the machine's change count, `0` before its first raise.
pub(crate) fn machine_version_statement() -> WriteStatement {
    statement(MACHINE_VERSION_SQL, Vec::new())
}

// The raise of the delivery's session's counts while it is pending, or of the machine's alone once
// its entry is gone.
fn bump_if_pending(delivery: &QueuedDelivery) -> WriteStatement {
    match delivery.session_id {
        Some(session_id) => statement(
            &BUMP_IF_PENDING_SQL,
            vec![
                session_binding(session_id),
                text_binding("@entry_id", &delivery.entry_id),
            ],
        ),
        None => statement(&MACHINE_VERSION_BUMP_SQL, Vec::new()),
    }
}

fn read_deliveries(reader: &Connection, sql: &str) -> rusqlite::Result<Vec<QueuedDelivery>> {
    reader
        .prepare_cached(sql)?
        .query_map([], QueuedDelivery::of_row)?
        .collect()
}

fn read_pickup_deliveries(reader: &Connection, sql: &str) -> rusqlite::Result<Vec<PickupDelivery>> {
    reader
        .prepare_cached(sql)?
        .query_map([], PickupDelivery::of_row)?
        .collect()
}

fn trigger_list(triggers: &[AttentionTrigger]) -> String {
    sql_list_of(triggers.iter().copied().map(<&'static str>::from))
}
