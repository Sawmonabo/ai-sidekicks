//! The exchange table: one row per pair of sessions trading messages, counting the messages since
//! the person last wrote in either, which each session's line shows and an interrupt follows to
//! reach the other end.

use std::borrow::Cow;
use std::sync::Arc;

use rusqlite::{OptionalExtension as _, named_params};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_ipc::not_found::session::session_not_found;
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::{safe_int_column, text_column};
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};

use crate::directory::lookups::{SessionWriteError, session_exists_statement};
use crate::messaging::{SessionMessagingError, returned_integer, returned_parsed};

/// The statements the store's reads run: a session's line.
pub const SESSION_EXCHANGE_STORE_STATEMENT_CAPACITY: usize = 1;

/// Deletes every exchange the session the `@sessionId` parameter names is on, at either end: the
/// person writing in it, and the purge of it.
pub const DELETE_SESSION_EXCHANGES_SQL: &str =
    "DELETE FROM session_exchanges WHERE session_id = @sessionId OR peer_session_id = @sessionId";

const RECORD_MESSAGE_SQL: &str = "INSERT INTO session_exchanges
    (session_id, peer_session_id, messages_since_user_wrote, started_at, updated_at)
  VALUES (@sessionId, @peerSessionId, 1, @now, @now)
  ON CONFLICT (session_id, peer_session_id) DO UPDATE
    SET messages_since_user_wrote = messages_since_user_wrote + 1, updated_at = excluded.updated_at
  RETURNING messages_since_user_wrote";

// The other end of the session's latest exchange, and its count.
const SELECT_LINE_SQL: &str = "SELECT
    CASE WHEN session_id = @sessionId THEN peer_session_id ELSE session_id END,
    messages_since_user_wrote
  FROM session_exchanges WHERE session_id = @sessionId OR peer_session_id = @sessionId
  ORDER BY updated_at DESC, session_id, peer_session_id LIMIT 1";

// Deletes the session's latest exchange and answers its other end.
const TAKE_LATEST_SQL: &str = "DELETE FROM session_exchanges WHERE rowid =
    (SELECT rowid FROM session_exchanges
       WHERE session_id = @sessionId OR peer_session_id = @sessionId
       ORDER BY updated_at DESC, session_id, peer_session_id LIMIT 1)
  RETURNING CASE WHEN session_id = @sessionId THEN peer_session_id ELSE session_id END";

// The record's place in its write, after the two sessions' existence checks.
const RECORD_STATEMENT_INDEX: usize = 2;

/// Deletes every exchange `session_id` is on, for the write that records the person writing in it,
/// so the next message between the pair starts a new count at one.
pub fn person_wrote_statement(session_id: &SessionId) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(DELETE_SESSION_EXCHANGES_SQL),
        bindings: StatementBindings::Named(vec![text_binding(
            "@sessionId",
            session_id.text().as_str(),
        )]),
        expected_row_count: None,
    }
}

/// A session's exchange line as the store holds it: the other session and the messages the two
/// traded since the person last wrote in either. The other session's name is the directory's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExchangePeer {
    /// The other session.
    pub peer_session_id: SessionId,
    /// The messages traded.
    pub message_count: SafeInt<1>,
}

/// Reads the exchanges through the daemon's read pool and writes them through its writer.
pub struct SessionExchangeStore {
    pool: Arc<DatabaseReadPool>,
    writer: Arc<DatabaseWriter>,
}

impl SessionExchangeStore {
    /// The store reading through `pool` and writing through `writer`.
    pub fn new(pool: Arc<DatabaseReadPool>, writer: Arc<DatabaseWriter>) -> Self {
        Self { pool, writer }
    }

    /// Counts one message between `session_id` and `peer_session_id`, a send reaching `sent` or an
    /// answer delivered back, in either direction, and answers the pair's count: one at the
    /// pair's first message. Fails with [`SessionMessagingError::Write`]: `session.notFound` for
    /// either session this daemon holds no row for, or the write not kept, which a session paired
    /// with itself is.
    pub async fn record_message(
        &self,
        session_id: &SessionId,
        peer_session_id: &SessionId,
    ) -> Result<SafeInt<1>, SessionMessagingError> {
        let (first, second) = if session_id.text().as_str() < peer_session_id.text().as_str() {
            (session_id, peer_session_id)
        } else {
            (peer_session_id, session_id)
        };
        let now = WireInstant::now();
        let record = WriteStatement {
            sql: Cow::Borrowed(RECORD_MESSAGE_SQL),
            bindings: StatementBindings::Named(vec![
                text_binding("@sessionId", first.text().as_str()),
                text_binding("@peerSessionId", second.text().as_str()),
                text_binding("@now", now.as_str()),
            ]),
            expected_row_count: Some(1),
        };
        let results = match self
            .writer
            .write(vec![
                session_exists_statement(first),
                session_exists_statement(second),
                record,
            ])
            .await
        {
            Ok(results) => results,
            Err(WriteError::Refused {
                statement_index: 0, ..
            }) => return Err(SessionWriteError::from(session_not_found(first)).into()),
            Err(WriteError::Refused {
                statement_index: 1, ..
            }) => return Err(SessionWriteError::from(session_not_found(second)).into()),
            Err(error) => return Err(error.into()),
        };
        let row = results
            .get(RECORD_STATEMENT_INDEX)
            .and_then(|result| result.rows.first())
            .expect("a committed record answers its one returned count");
        let count = returned_integer(row, 0)?;
        Ok(u64::try_from(count)
            .ok()
            .and_then(SafeInt::new)
            .ok_or(rusqlite::Error::IntegralValueOutOfRange(0, count))?)
    }

    /// The line of `session_id`'s latest exchange, or `None` when it trades with no session. Fails
    /// with [`SessionMessagingError::Database`] or [`SessionMessagingError::Pool`] when the read
    /// does.
    pub async fn exchange_of(
        &self,
        session_id: SessionId,
    ) -> Result<Option<ExchangePeer>, SessionMessagingError> {
        self.pool
            .read(ReadLength::Short, move |connection| {
                connection
                    .prepare_cached(SELECT_LINE_SQL)?
                    .query_row(
                        named_params! { "@sessionId": session_id.text().as_str() },
                        |row| {
                            Ok(ExchangePeer {
                                peer_session_id: text_column(row, 0, |text| SessionId::new(&text))?,
                                message_count: safe_int_column(row, 1)?,
                            })
                        },
                    )
                    .optional()
                    .map_err(SessionMessagingError::from)
            })
            .await
    }

    /// Deletes `session_id`'s latest exchange, as an interrupt of it does, and answers the session
    /// on its other end, which the interrupt reaches too; `None` when it trades with no session.
    /// Fails with [`SessionMessagingError::Write`] when the write is not kept, and with
    /// [`SessionMessagingError::Database`] when the stored id does not read.
    pub async fn take_exchange_peer(
        &self,
        session_id: &SessionId,
    ) -> Result<Option<SessionId>, SessionMessagingError> {
        let mut results = self
            .writer
            .write(vec![WriteStatement {
                sql: Cow::Borrowed(TAKE_LATEST_SQL),
                bindings: StatementBindings::Named(vec![text_binding(
                    "@sessionId",
                    session_id.text().as_str(),
                )]),
                expected_row_count: None,
            }])
            .await?;
        let result = results
            .pop()
            .expect("a committed write answers for its one statement");
        Ok(result
            .rows
            .first()
            .map(|row| returned_parsed(row, 0, SessionId::new))
            .transpose()?)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::schema::session_directory::insert_session_row;
    use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
    use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};

    use super::{
        ExchangePeer, SESSION_EXCHANGE_STORE_STATEMENT_CAPACITY, SessionExchangeStore,
        person_wrote_statement,
    };
    use crate::messaging::schema::schema_parts;

    // A line as the other session's id and the count.
    fn count(line: Option<ExchangePeer>) -> Option<(SessionId, u64)> {
        line.map(|line| (line.peer_session_id, line.message_count.get()))
    }

    // Killed by storing the pair in the order it was sent (A to B and B to A become two rows, and
    // the second count reads 1), by the person's write leaving the row (the line after it still
    // reads 2), and by a reset that only zeroes the count (the next message reads 1 only when the
    // row was deleted, and a zeroed row fails the count's CHECK or reads as a line of 0).
    #[tokio::test]
    async fn a_pair_is_one_count_until_the_person_writes_in_either_session() {
        let database = TestDatabase::new(schema_parts());
        let writer = Arc::new(
            DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
                .await
                .expect("the writer opens its database"),
        );
        let store = SessionExchangeStore::new(
            Arc::new(DatabaseReadPool::new(
                database.path(),
                SESSION_EXCHANGE_STORE_STATEMENT_CAPACITY,
            )),
            Arc::clone(&writer),
        );
        let (a, b) = (test_session_id(), test_session_id());
        for session_id in [&a, &b] {
            insert_session_row(&database.reader(), session_id.text().as_str(), None, None);
        }

        let first = store
            .record_message(&a, &b)
            .await
            .expect("A to B is counted");
        let second = store
            .record_message(&b, &a)
            .await
            .expect("B to A is counted");
        assert_eq!((first.get(), second.get()), (1, 2));
        assert_eq!(
            count(store.exchange_of(a).await.expect("A's line reads")),
            Some((b, 2))
        );
        assert_eq!(
            count(store.exchange_of(b).await.expect("B's line reads")),
            Some((a, 2))
        );

        writer
            .write(vec![person_wrote_statement(&b)])
            .await
            .expect("the person's write in B is kept");
        assert_eq!(
            count(store.exchange_of(a).await.expect("A's line reads")),
            None
        );

        let restarted = store
            .record_message(&a, &b)
            .await
            .expect("the next message is counted");
        assert_eq!(restarted.get(), 1);
    }
}
