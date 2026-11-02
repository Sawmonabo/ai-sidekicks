//! The paused queue: every message addressed to a paused session, in arrival order, each row naming
//! the send's own event, never its words. Its rows are delivered one at a time when the session
//! continues, each deleted in the write that records its delivery.

use std::borrow::Cow;
use std::sync::Arc;

use rusqlite::types::Value;
use rusqlite::{Row, named_params};
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::{
    returned_integer, returned_parsed, safe_int_column, text_column,
};
use sidekicks_store::database::writer::DatabaseWriter;

use crate::directory::lookups::write_while_session_exists;
use crate::messaging::SessionMessagingError;

/// The statements the store's reads run: a target's held messages.
pub const PAUSED_QUEUE_STORE_STATEMENT_CAPACITY: usize = 1;

/// Deletes every message held for, or sent by, the session the `@sessionId` parameter names: the
/// purge of it, whose held sends could no longer be read or answered.
pub const DELETE_SESSION_PAUSED_MESSAGES_SQL: &str = "DELETE FROM session_paused_message_queue
  WHERE target_session_id = @sessionId OR source_session_id = @sessionId";

// The `WHERE` lets SQLite read the upsert clause after an `INSERT … SELECT`.
const ENQUEUE_SQL: &str = "INSERT INTO session_paused_message_queue
    (target_session_id, arrival_sequence, source_session_id, source_event_id, arrived_at)
  SELECT @targetSessionId, COALESCE(MAX(arrival_sequence), 0) + 1, @sourceSessionId,
    @sourceEventId, @arrivedAt
  FROM session_paused_message_queue WHERE target_session_id = @targetSessionId
  ON CONFLICT (target_session_id, source_event_id) DO NOTHING
  RETURNING arrival_sequence";

const SELECT_TARGET_SQL: &str = "SELECT target_session_id, arrival_sequence, source_session_id,
    source_event_id, arrived_at
  FROM session_paused_message_queue WHERE target_session_id = @targetSessionId
  ORDER BY arrival_sequence";

const DELETE_DELIVERED_SQL: &str = "DELETE FROM session_paused_message_queue
  WHERE target_session_id = @targetSessionId AND arrival_sequence = @arrivalSequence";

// Each drain answers its deleted rows in the columns `held_message_of_returned` reads.
const DRAIN_TARGET_SQL: &str = "DELETE FROM session_paused_message_queue
  WHERE target_session_id = @targetSessionId
  RETURNING target_session_id, arrival_sequence, source_session_id, source_event_id, arrived_at";

const DRAIN_PAIR_SQL: &str = "DELETE FROM session_paused_message_queue
  WHERE (target_session_id = @sessionId AND source_session_id = @peerSessionId)
     OR (target_session_id = @peerSessionId AND source_session_id = @sessionId)
  RETURNING target_session_id, arrival_sequence, source_session_id, source_event_id, arrived_at";

/// One message held for a paused session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeldMessage {
    /// The paused session it is addressed to.
    pub target_session_id: SessionId,
    /// Its place in the target's arrival order, from 1.
    pub arrival_sequence: SafeInt<1>,
    /// The sending session.
    pub source_session_id: SessionId,
    /// The send's own event in the sending session's log, which holds the words.
    pub source_event_id: FreeFormText<EVENT_FIELD_MAX_LEN>,
    /// When it reached the daemon.
    pub arrived_at: WireInstant,
}

/// What a hold of one send did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PausedQueueHold {
    /// The send is held at this place in the target's arrival order.
    Held {
        /// Its place, from 1.
        arrival_sequence: SafeInt<1>,
    },
    /// The send was already held for the target, so nothing was added.
    AlreadyHeld,
}

/// Deletes the delivered message `message`, for the write that records its delivery, which it
/// refuses and rolls back when the row is already gone, so one message is never delivered twice.
pub fn delivered_statement(message: &HeldMessage) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(DELETE_DELIVERED_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding(
                "@targetSessionId",
                message.target_session_id.text().as_str(),
            ),
            (
                Cow::Borrowed("@arrivalSequence"),
                Value::Integer(i64::from(message.arrival_sequence)),
            ),
        ]),
        expected_row_count: Some(1),
    }
}

/// Reads the paused queue through the daemon's read pool and writes it through its writer.
pub struct PausedQueueStore {
    pool: Arc<DatabaseReadPool>,
    writer: Arc<DatabaseWriter>,
}

impl PausedQueueStore {
    /// The store reading through `pool` and writing through `writer`.
    pub fn new(pool: Arc<DatabaseReadPool>, writer: Arc<DatabaseWriter>) -> Self {
        Self { pool, writer }
    }

    /// Holds the send `source_event_id` from `source_session_id` for the paused
    /// `target_session_id`, at the target's next place, arrived now; a send already held answers
    /// [`PausedQueueHold::AlreadyHeld`]. Fails with [`SessionMessagingError::Write`]:
    /// `session.notFound` for a target this daemon holds no row for, or the write not kept.
    pub async fn hold(
        &self,
        target_session_id: &SessionId,
        source_session_id: &SessionId,
        source_event_id: &FreeFormText<EVENT_FIELD_MAX_LEN>,
    ) -> Result<PausedQueueHold, SessionMessagingError> {
        let arrived_at = WireInstant::now();
        let result = write_while_session_exists(
            &self.writer,
            target_session_id,
            WriteStatement {
                sql: Cow::Borrowed(ENQUEUE_SQL),
                bindings: StatementBindings::Named(vec![
                    text_binding("@targetSessionId", target_session_id.text().as_str()),
                    text_binding("@sourceSessionId", source_session_id.text().as_str()),
                    text_binding("@sourceEventId", source_event_id.as_str()),
                    text_binding("@arrivedAt", arrived_at.as_str()),
                ]),
                expected_row_count: None,
            },
        )
        .await?;
        let Some(row) = result.rows.first() else {
            return Ok(PausedQueueHold::AlreadyHeld);
        };
        let sequence = returned_integer(row, 0)?;
        let arrival_sequence = u64::try_from(sequence)
            .ok()
            .and_then(SafeInt::new)
            .ok_or(rusqlite::Error::IntegralValueOutOfRange(0, sequence))?;
        Ok(PausedQueueHold::Held { arrival_sequence })
    }

    /// The messages held for `target_session_id`, in arrival order. Fails with
    /// [`SessionMessagingError::Database`] or [`SessionMessagingError::Pool`] when the read does.
    pub async fn held_for(
        &self,
        target_session_id: SessionId,
    ) -> Result<Vec<HeldMessage>, SessionMessagingError> {
        self.pool
            .read(ReadLength::Short, move |connection| {
                connection
                    .prepare_cached(SELECT_TARGET_SQL)?
                    .query_map(
                        named_params! { "@targetSessionId": target_session_id.text().as_str() },
                        held_message_of_row,
                    )?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(SessionMessagingError::from)
            })
            .await
    }

    /// Deletes every message held for `target_session_id`, as its purge does, and answers them in
    /// arrival order, each one the caller settles as not delivered. Fails with
    /// [`SessionMessagingError::Write`] when the write is not kept, and with
    /// [`SessionMessagingError::Database`] when a stored value does not read.
    pub async fn drain_target(
        &self,
        target_session_id: &SessionId,
    ) -> Result<Vec<HeldMessage>, SessionMessagingError> {
        self.drain(
            DRAIN_TARGET_SQL,
            vec![text_binding(
                "@targetSessionId",
                target_session_id.text().as_str(),
            )],
        )
        .await
    }

    /// Deletes every message either of `session_id` and `peer_session_id` holds from the other, as
    /// an interrupt of their exchange does, and answers them in arrival order per target, each one
    /// the caller settles as not delivered. Fails as [`PausedQueueStore::drain_target`] does.
    pub async fn drain_pair(
        &self,
        session_id: &SessionId,
        peer_session_id: &SessionId,
    ) -> Result<Vec<HeldMessage>, SessionMessagingError> {
        self.drain(
            DRAIN_PAIR_SQL,
            vec![
                text_binding("@sessionId", session_id.text().as_str()),
                text_binding("@peerSessionId", peer_session_id.text().as_str()),
            ],
        )
        .await
    }

    // Runs the deleting `sql` and answers the deleted rows, ordered by target and arrival, since
    // SQLite returns a delete's rows in no set order.
    async fn drain(
        &self,
        sql: &'static str,
        bindings: Vec<(Cow<'static, str>, Value)>,
    ) -> Result<Vec<HeldMessage>, SessionMessagingError> {
        let mut results = self
            .writer
            .write(vec![WriteStatement {
                sql: Cow::Borrowed(sql),
                bindings: StatementBindings::Named(bindings),
                expected_row_count: None,
            }])
            .await?;
        let result = results
            .pop()
            .expect("a committed write answers for its one statement");
        let mut drained = result
            .rows
            .iter()
            .map(|row| held_message_of_returned(row))
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drained.sort_by(|left, right| {
            (
                left.target_session_id.text().as_str(),
                left.arrival_sequence,
            )
                .cmp(&(
                    right.target_session_id.text().as_str(),
                    right.arrival_sequence,
                ))
        });
        Ok(drained)
    }
}

// A held message from a read's row, in the columns `SELECT_TARGET_SQL` selects.
fn held_message_of_row(row: &Row<'_>) -> rusqlite::Result<HeldMessage> {
    Ok(HeldMessage {
        target_session_id: text_column(row, 0, |text| SessionId::new(&text))?,
        arrival_sequence: safe_int_column(row, 1)?,
        source_session_id: text_column(row, 2, |text| SessionId::new(&text))?,
        source_event_id: text_column(row, 3, FreeFormText::new)?,
        arrived_at: text_column(row, 4, WireInstant::try_from)?,
    })
}

// A held message from a drain's returned row.
fn held_message_of_returned(row: &[Value]) -> rusqlite::Result<HeldMessage> {
    let sequence = returned_integer(row, 1)?;
    Ok(HeldMessage {
        target_session_id: returned_parsed(row, 0, SessionId::new)?,
        arrival_sequence: u64::try_from(sequence)
            .ok()
            .and_then(SafeInt::new)
            .ok_or(rusqlite::Error::IntegralValueOutOfRange(1, sequence))?,
        source_session_id: returned_parsed(row, 2, SessionId::new)?,
        source_event_id: returned_parsed(row, 3, |text| FreeFormText::new(text.to_owned()))?,
        arrived_at: returned_parsed(row, 4, |text| WireInstant::try_from(text.to_owned()))?,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_contracts::wire::text::FreeFormText;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::schema::session_directory::insert_session_row;
    use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
    use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions, WriteError};

    use super::{
        PAUSED_QUEUE_STORE_STATEMENT_CAPACITY, PausedQueueHold, PausedQueueStore,
        delivered_statement,
    };
    use crate::messaging::schema::schema_parts;

    fn event_id() -> FreeFormText<EVENT_FIELD_MAX_LEN> {
        FreeFormText::new(mint_uuid_v7().to_string()).expect("a UUID is an event id")
    }

    // Killed by ordering the read by `arrived_at` (the first arrival is stamped a millisecond after
    // the second, as a clock stepping back within one millisecond leaves them), by ordering it by
    // the send's id (the first arrival's id sorts last), by a second hold of one send adding a
    // row or failing, and by the delivered row's delete expecting no count (a second delivery of
    // the same row would then commit).
    #[tokio::test]
    async fn held_messages_keep_arrival_order_and_each_is_held_and_delivered_once() {
        let database = TestDatabase::new(schema_parts());
        let writer = Arc::new(
            DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
                .await
                .expect("the writer opens its database"),
        );
        let store = PausedQueueStore::new(
            Arc::new(DatabaseReadPool::new(
                database.path(),
                PAUSED_QUEUE_STORE_STATEMENT_CAPACITY,
            )),
            Arc::clone(&writer),
        );
        let (target, source) = (test_session_id(), test_session_id());
        insert_session_row(&database.reader(), target.text().as_str(), None, None);
        // Minted ids sort in mint order, so the send held first takes the later id.
        let (earlier_id, later_id) = (event_id(), event_id());

        let first = store
            .hold(&target, &source, &later_id)
            .await
            .expect("the first send is held");
        let second = store
            .hold(&target, &source, &earlier_id)
            .await
            .expect("the second send is held");
        let again = store
            .hold(&target, &source, &later_id)
            .await
            .expect("a second hold of one send is no failure");
        database
            .reader()
            .execute(
                "UPDATE session_paused_message_queue SET arrived_at = CASE arrival_sequence
                   WHEN 1 THEN '2026-11-02T09:00:00.001Z' ELSE '2026-11-02T09:00:00.000Z' END",
                [],
            )
            .expect("the test stamps the first arrival after the second");

        assert!(matches!(
            first,
            PausedQueueHold::Held { arrival_sequence } if arrival_sequence.get() == 1
        ));
        assert!(matches!(
            second,
            PausedQueueHold::Held { arrival_sequence } if arrival_sequence.get() == 2
        ));
        assert_eq!(again, PausedQueueHold::AlreadyHeld);
        let held = store.held_for(target).await.expect("the queue reads");
        assert_eq!(
            held.iter()
                .map(|message| message.source_event_id.clone())
                .collect::<Vec<_>>(),
            vec![later_id, earlier_id]
        );

        let delivered = held.first().expect("two messages are held");
        writer
            .write(vec![delivered_statement(delivered)])
            .await
            .expect("the first delivery's write is kept");
        let repeated = writer.write(vec![delivered_statement(delivered)]).await;
        assert!(
            matches!(
                repeated,
                Err(WriteError::Refused {
                    statement_index: 0,
                    row_count: 0
                })
            ),
            "a delivery of a row already gone is refused: {repeated:?}"
        );
        assert_eq!(
            store.held_for(target).await.expect("the queue reads").len(),
            1
        );
    }
}
