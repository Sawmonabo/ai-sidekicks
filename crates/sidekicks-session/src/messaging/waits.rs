//! The waits: what each session waits on, one row per awaited session of one waiting call, kept so
//! the call is answered or its session woken at the first of them to finish or need the person,
//! after a restart too.

use std::borrow::Cow;
use std::sync::Arc;

use rusqlite::types::Value;
use rusqlite::{Row, named_params};
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_provider::driver::agent_tools::AgentToolWait;
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::{closed_word, text_column};
use sidekicks_store::database::writer::DatabaseWriter;

use crate::directory::lookups::write_while_session_exists;
use crate::messaging::SessionMessagingError;

/// The statements the store's reads run: a session's waits, the calls waiting on a session, and
/// every wait.
pub const SESSION_WAIT_STORE_STATEMENT_CAPACITY: usize = 3;

/// Deletes every wait of, or on, the session the `@sessionId` parameter names: the purge of it,
/// after which no call can wait on it or be answered for it.
pub const DELETE_SESSION_WAITS_SQL: &str =
    "DELETE FROM session_waits WHERE session_id = @sessionId OR awaited_session_id = @sessionId";

// One row per distinct awaited session; a call recorded again keeps its first rows. The `WHERE`
// lets SQLite read the upsert clause after an `INSERT … SELECT`.
const RECORD_SQL: &str = "INSERT INTO session_waits
    (session_id, tool_call_id, awaited_session_id, form, created_at)
  SELECT DISTINCT @sessionId, @toolCallId, value, @form, @createdAt
  FROM json_each(@awaitedSessionIds) WHERE true
  ON CONFLICT (session_id, tool_call_id, awaited_session_id) DO NOTHING";

const SELECT_OF_SESSION_SQL: &str = "SELECT session_id, tool_call_id, awaited_session_id, form,
    created_at
  FROM session_waits WHERE session_id = @sessionId
  ORDER BY created_at, tool_call_id, awaited_session_id";

const SELECT_ON_SESSION_SQL: &str = "SELECT session_id, tool_call_id, awaited_session_id, form,
    created_at
  FROM session_waits WHERE awaited_session_id = @sessionId
  ORDER BY created_at, session_id, tool_call_id";

const SELECT_EVERY_SQL: &str = "SELECT session_id, tool_call_id, awaited_session_id, form,
    created_at
  FROM session_waits ORDER BY created_at, session_id, tool_call_id, awaited_session_id";

const DELETE_CALL_SQL: &str =
    "DELETE FROM session_waits WHERE session_id = @sessionId AND tool_call_id = @toolCallId";

/// One awaited session of one waiting call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionWait {
    /// The waiting session.
    pub session_id: SessionId,
    /// The provider's id of the call that waits.
    pub tool_call_id: ToolCallId,
    /// The session it waits on.
    pub awaited_session_id: SessionId,
    /// How the waiting session's provider waits.
    pub form: AgentToolWait,
    /// When the wait began.
    pub created_at: WireInstant,
}

/// Reads the waits through the daemon's read pool and writes them through its writer.
pub struct SessionWaitStore {
    pool: Arc<DatabaseReadPool>,
    writer: Arc<DatabaseWriter>,
}

impl SessionWaitStore {
    /// The store reading through `pool` and writing through `writer`.
    pub fn new(pool: Arc<DatabaseReadPool>, writer: Arc<DatabaseWriter>) -> Self {
        Self { pool, writer }
    }

    /// Records that `session_id`'s call `tool_call_id` waits, in `form`, on each of
    /// `awaited_session_ids`, one row each in one write. Fails with
    /// [`SessionMessagingError::Write`]: `session.notFound` for a waiting session this daemon
    /// holds no row for, or the write not kept.
    pub async fn record(
        &self,
        session_id: &SessionId,
        tool_call_id: &ToolCallId,
        form: AgentToolWait,
        awaited_session_ids: &[SessionId],
    ) -> Result<(), SessionMessagingError> {
        let awaited = serde_json::to_string(awaited_session_ids)
            .expect("a list of session ids serializes as JSON");
        let created_at = WireInstant::now();
        write_while_session_exists(
            &self.writer,
            session_id,
            WriteStatement {
                sql: Cow::Borrowed(RECORD_SQL),
                bindings: StatementBindings::Named(vec![
                    text_binding("@sessionId", session_id.text().as_str()),
                    text_binding("@toolCallId", tool_call_id.as_str()),
                    text_binding("@form", <&'static str>::from(form)),
                    text_binding("@createdAt", created_at.as_str()),
                    (Cow::Borrowed("@awaitedSessionIds"), Value::Text(awaited)),
                ]),
                expected_row_count: None,
            },
        )
        .await?;
        Ok(())
    }

    /// What `session_id` waits on, oldest first. Fails with [`SessionMessagingError::Database`]
    /// or [`SessionMessagingError::Pool`] when the read does.
    pub async fn waits_of(
        &self,
        session_id: SessionId,
    ) -> Result<Vec<SessionWait>, SessionMessagingError> {
        self.read_waits(SELECT_OF_SESSION_SQL, Some(session_id))
            .await
    }

    /// The waits on `awaited_session_id`, one per waiting call, which its finish or its need of
    /// the person answers or wakes. Fails as [`SessionWaitStore::waits_of`] does.
    pub async fn waits_on(
        &self,
        awaited_session_id: SessionId,
    ) -> Result<Vec<SessionWait>, SessionMessagingError> {
        self.read_waits(SELECT_ON_SESSION_SQL, Some(awaited_session_id))
            .await
    }

    /// Every wait the daemon keeps, which its start reads to wake each one still owed. Fails as
    /// [`SessionWaitStore::waits_of`] does.
    pub async fn every_wait(&self) -> Result<Vec<SessionWait>, SessionMessagingError> {
        self.read_waits(SELECT_EVERY_SQL, None).await
    }

    /// Removes every row of `session_id`'s call `tool_call_id`, once it is answered or canceled,
    /// and answers how many it removed. Fails with [`SessionMessagingError::Write`] when the write
    /// is not kept.
    pub async fn remove_call(
        &self,
        session_id: &SessionId,
        tool_call_id: &ToolCallId,
    ) -> Result<usize, SessionMessagingError> {
        let mut results = self
            .writer
            .write(vec![WriteStatement {
                sql: Cow::Borrowed(DELETE_CALL_SQL),
                bindings: StatementBindings::Named(vec![
                    text_binding("@sessionId", session_id.text().as_str()),
                    text_binding("@toolCallId", tool_call_id.as_str()),
                ]),
                expected_row_count: None,
            }])
            .await?;
        Ok(results
            .pop()
            .expect("a committed write answers for its one statement")
            .row_count)
    }

    // The waits `sql` selects, its `@sessionId` bound to `session_id` where it takes one.
    async fn read_waits(
        &self,
        sql: &'static str,
        session_id: Option<SessionId>,
    ) -> Result<Vec<SessionWait>, SessionMessagingError> {
        self.pool
            .read(ReadLength::Short, move |connection| {
                let mut statement = connection.prepare_cached(sql)?;
                let waits = match &session_id {
                    Some(session_id) => statement.query_map(
                        named_params! { "@sessionId": session_id.text().as_str() },
                        session_wait_of_row,
                    )?,
                    None => statement.query_map([], session_wait_of_row)?,
                };
                waits
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(SessionMessagingError::from)
            })
            .await
    }
}

// A wait from a row in the columns every read here selects, in their order.
fn session_wait_of_row(row: &Row<'_>) -> rusqlite::Result<SessionWait> {
    Ok(SessionWait {
        session_id: text_column(row, 0, |text| SessionId::new(&text))?,
        tool_call_id: text_column(row, 1, ToolCallId::new)?,
        awaited_session_id: text_column(row, 2, |text| SessionId::new(&text))?,
        form: text_column(row, 3, closed_word)?,
        created_at: text_column(row, 4, WireInstant::try_from)?,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use sidekicks_contracts::provider::tool_call::ToolCallId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::schema::session_directory::insert_session_row;
    use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
    use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};

    use super::{
        AgentToolWait, SESSION_WAIT_STORE_STATEMENT_CAPACITY, SessionWait, SessionWaitStore,
    };
    use crate::messaging::schema::schema_parts;

    fn call_id(text: &str) -> ToolCallId {
        ToolCallId::new(text.to_owned()).expect("a test call id")
    }

    // Killed by storing a call as one row (it would read one wait, not three), by removing by
    // the waiting session instead of by the call (the other call's row would go too), and by the
    // waits on a session listing a call per row of the call (the awaited session would list the
    // waiting call more than once).
    #[tokio::test]
    async fn a_call_waits_on_each_session_once_and_is_removed_whole() {
        let database = TestDatabase::new(schema_parts());
        let writer = Arc::new(
            DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
                .await
                .expect("the writer opens its database"),
        );
        let store = SessionWaitStore::new(
            Arc::new(DatabaseReadPool::new(
                database.path(),
                SESSION_WAIT_STORE_STATEMENT_CAPACITY,
            )),
            writer,
        );
        let waiting = test_session_id();
        insert_session_row(&database.reader(), waiting.text().as_str(), None, None);
        let awaited: Vec<SessionId> = (0..3).map(|_| test_session_id()).collect();
        let (call, other_call) = (call_id("call-1"), call_id("call-2"));

        store
            .record(&waiting, &call, AgentToolWait::AnsweredThenWoken, &awaited)
            .await
            .expect("the call's waits are kept");
        store
            .record(
                &waiting,
                &other_call,
                AgentToolWait::AnsweredThenWoken,
                &awaited[..1],
            )
            .await
            .expect("the other call's wait is kept");

        let of_call = |waits: &[SessionWait]| {
            waits
                .iter()
                .filter(|wait| wait.tool_call_id == call)
                .map(|wait| wait.awaited_session_id)
                .collect::<Vec<_>>()
        };
        let mut awaited_by_call = of_call(&store.waits_of(waiting).await.expect("reads"));
        awaited_by_call.sort_by(|left, right| left.text().as_str().cmp(right.text().as_str()));
        let mut expected = awaited.clone();
        expected.sort_by(|left, right| left.text().as_str().cmp(right.text().as_str()));
        assert_eq!(awaited_by_call, expected);

        let on_last = store
            .waits_on(awaited[2])
            .await
            .expect("the waits on a session read");
        assert_eq!(
            on_last
                .iter()
                .map(|wait| (wait.session_id, wait.tool_call_id.clone()))
                .collect::<Vec<_>>(),
            vec![(waiting, call.clone())]
        );

        let removed = store
            .remove_call(&waiting, &call)
            .await
            .expect("the call's rows are removed");
        assert_eq!(removed, 3);
        let left = store.every_wait().await.expect("every wait reads");
        assert_eq!(
            left.iter()
                .map(|wait| (wait.tool_call_id.clone(), wait.awaited_session_id))
                .collect::<Vec<_>>(),
            vec![(other_call, awaited[0])]
        );
    }
}
