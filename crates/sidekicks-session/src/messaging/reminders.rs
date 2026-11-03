//! The reminders a session set: each note and when it was set and is due, kept until it fires, so
//! the scheduler's one timer is armed at the earliest due of all and a reminder due while the
//! daemon was down fires when it is back.

use std::borrow::Cow;
use std::sync::Arc;

use rusqlite::{Row, named_params};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::text_column;
use sidekicks_store::database::writer::DatabaseWriter;
use uuid::Uuid;

use crate::directory::lookups::write_while_session_exists;
use crate::messaging::SessionMessagingError;

/// The statements the store's reads run: the earliest due, those due by an instant, and a
/// session's reminders.
pub const SESSION_REMINDER_STORE_STATEMENT_CAPACITY: usize = 3;

/// Deletes every reminder of the session the `@sessionId` parameter names: the purge of it.
pub const DELETE_SESSION_REMINDERS_SQL: &str =
    "DELETE FROM session_reminders WHERE session_id = @sessionId";

const INSERT_SQL: &str = "INSERT INTO session_reminders (id, session_id, note, set_at, due_at)
  VALUES (@id, @sessionId, @note, @setAt, @dueAt)";

const SELECT_EARLIEST_DUE_SQL: &str = "SELECT MIN(due_at) FROM session_reminders";

// Every stored instant has one fixed form, so text order is time order.
const SELECT_DUE_BY_SQL: &str = "SELECT id, session_id, note, set_at, due_at
  FROM session_reminders WHERE due_at <= @at ORDER BY due_at, id";

const SELECT_OF_SESSION_SQL: &str = "SELECT id, session_id, note, set_at, due_at
  FROM session_reminders WHERE session_id = @sessionId ORDER BY due_at, id";

const DELETE_SQL: &str = "DELETE FROM session_reminders WHERE id = @id";

/// Identifies one reminder.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct SessionReminderId(Uuid);

impl SessionReminderId {
    // A fresh id.
    fn mint() -> Self {
        Self(mint_uuid_v7())
    }

    // The id as it is stored, hyphenated in lower case.
    fn stored_text(self) -> String {
        self.0.hyphenated().to_string()
    }
}

/// One reminder a session set.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionReminder {
    /// The reminder.
    pub id: SessionReminderId,
    /// The session it wakes.
    pub session_id: SessionId,
    /// The session's own words for what to do when it wakes.
    pub note: FreeFormText<{ usize::MAX }>,
    /// When the session set it.
    pub set_at: WireInstant,
    /// When it is due.
    pub due_at: WireInstant,
}

/// Reads the reminders through the daemon's read pool and writes them through its writer.
pub struct SessionReminderStore {
    pool: Arc<DatabaseReadPool>,
    writer: Arc<DatabaseWriter>,
}

impl SessionReminderStore {
    /// The store reading through `pool` and writing through `writer`.
    pub fn new(pool: Arc<DatabaseReadPool>, writer: Arc<DatabaseWriter>) -> Self {
        Self { pool, writer }
    }

    /// Keeps `session_id`'s reminder `note`, set now and due at `due_at`, and answers it. Fails
    /// with [`SessionMessagingError::InstantOutOfRange`] for a due time before the year 0000, and
    /// with [`SessionMessagingError::Write`]: `session.notFound` for a session this daemon holds
    /// no row for, or the write not kept.
    pub async fn set(
        &self,
        session_id: &SessionId,
        note: FreeFormText<{ usize::MAX }>,
        due_at: jiff::Timestamp,
    ) -> Result<SessionReminder, SessionMessagingError> {
        let reminder = SessionReminder {
            id: SessionReminderId::mint(),
            session_id: *session_id,
            note,
            set_at: WireInstant::now(),
            due_at: stored_instant(due_at)?,
        };
        write_while_session_exists(
            &self.writer,
            session_id,
            WriteStatement {
                sql: Cow::Borrowed(INSERT_SQL),
                bindings: StatementBindings::Named(vec![
                    text_binding("@id", &reminder.id.stored_text()),
                    text_binding("@sessionId", session_id.text().as_str()),
                    text_binding("@note", reminder.note.as_str()),
                    text_binding("@setAt", reminder.set_at.as_str()),
                    text_binding("@dueAt", reminder.due_at.as_str()),
                ]),
                expected_row_count: Some(1),
            },
        )
        .await?;
        Ok(reminder)
    }

    /// When the earliest of every session's reminders is due, which the scheduler arms its one
    /// timer at; `None` when no reminder is kept. Fails with [`SessionMessagingError::Database`]
    /// or [`SessionMessagingError::Pool`] when the read does.
    pub async fn earliest_due(&self) -> Result<Option<WireInstant>, SessionMessagingError> {
        self.pool
            .read(ReadLength::Short, |connection| {
                connection
                    .prepare_cached(SELECT_EARLIEST_DUE_SQL)?
                    .query_row([], |row| {
                        let due: Option<String> = row.get(0)?;
                        due.map(|due| {
                            WireInstant::try_from(due).map_err(|error| {
                                rusqlite::Error::FromSqlConversionFailure(
                                    0,
                                    rusqlite::types::Type::Text,
                                    Box::new(error),
                                )
                            })
                        })
                        .transpose()
                    })
                    .map_err(SessionMessagingError::from)
            })
            .await
    }

    /// Every reminder due at or before `at`, earliest first, each naming when it was set and when
    /// it was due. Fails with [`SessionMessagingError::InstantOutOfRange`] for an instant before
    /// the year 0000, and as [`SessionReminderStore::earliest_due`] does.
    pub async fn due_by(
        &self,
        at: jiff::Timestamp,
    ) -> Result<Vec<SessionReminder>, SessionMessagingError> {
        let at = stored_instant(at)?;
        self.pool
            .read(ReadLength::Short, move |connection| {
                connection
                    .prepare_cached(SELECT_DUE_BY_SQL)?
                    .query_map(named_params! { "@at": at.as_str() }, reminder_of_row)?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(SessionMessagingError::from)
            })
            .await
    }

    /// `session_id`'s reminders, earliest due first. Fails as
    /// [`SessionReminderStore::earliest_due`] does.
    pub async fn reminders_of(
        &self,
        session_id: SessionId,
    ) -> Result<Vec<SessionReminder>, SessionMessagingError> {
        self.pool
            .read(ReadLength::Short, move |connection| {
                connection
                    .prepare_cached(SELECT_OF_SESSION_SQL)?
                    .query_map(
                        named_params! { "@sessionId": session_id.text().as_str() },
                        reminder_of_row,
                    )?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(SessionMessagingError::from)
            })
            .await
    }

    /// Removes the reminder `id` once it fired, and answers whether it was still kept. Fails with
    /// [`SessionMessagingError::Write`] when the write is not kept.
    pub async fn remove(&self, id: SessionReminderId) -> Result<bool, SessionMessagingError> {
        let mut results = self
            .writer
            .write(vec![WriteStatement {
                sql: Cow::Borrowed(DELETE_SQL),
                bindings: StatementBindings::Named(vec![text_binding("@id", &id.stored_text())]),
                expected_row_count: None,
            }])
            .await?;
        Ok(results
            .pop()
            .expect("a committed write answers for its one statement")
            .row_count
            == 1)
    }
}

// `timestamp` in the one stored form, which keeps text order equal to time order.
fn stored_instant(timestamp: jiff::Timestamp) -> Result<WireInstant, SessionMessagingError> {
    WireInstant::from_timestamp(timestamp).ok_or(SessionMessagingError::InstantOutOfRange)
}

// A reminder from a row in the columns every read of reminders selects, in their order.
fn reminder_of_row(row: &Row<'_>) -> rusqlite::Result<SessionReminder> {
    Ok(SessionReminder {
        id: SessionReminderId(text_column(row, 0, |text| Uuid::parse_str(&text))?),
        session_id: text_column(row, 1, |text| SessionId::new(&text))?,
        note: text_column(row, 2, FreeFormText::new)?,
        set_at: text_column(row, 3, WireInstant::try_from)?,
        due_at: text_column(row, 4, WireInstant::try_from)?,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use jiff::{SignedDuration, Timestamp};
    use sidekicks_contracts::wire::text::FreeFormText;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::schema::session_directory::insert_session_row;
    use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
    use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};

    use super::{SESSION_REMINDER_STORE_STATEMENT_CAPACITY, SessionReminderStore};
    use crate::messaging::schema::schema_parts;

    async fn open_store(database: &TestDatabase) -> (SessionReminderStore, Arc<DatabaseWriter>) {
        let writer = Arc::new(
            DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
                .await
                .expect("the writer opens its database"),
        );
        let store = SessionReminderStore::new(
            Arc::new(DatabaseReadPool::new(
                database.path(),
                SESSION_REMINDER_STORE_STATEMENT_CAPACITY,
            )),
            Arc::clone(&writer),
        );
        (store, writer)
    }

    fn note(text: &str) -> FreeFormText<{ usize::MAX }> {
        FreeFormText::new(text.to_owned()).expect("a test note")
    }

    // Killed by dropping `set_at` (the reopened row would not name when it was set), by a due
    // bound that excludes its instant (the read at T2 would miss the reminder due at T2), by one
    // that reads a millisecond early, and by an earliest due taken per session (the session whose
    // reminder was set first, due later, would arm the timer).
    #[tokio::test]
    async fn a_reminder_keeps_both_times_across_a_reopen_and_is_due_from_its_instant() {
        let database = TestDatabase::new(schema_parts());
        let (store, writer) = open_store(&database).await;
        let (later_session, session) = (test_session_id(), test_session_id());
        for session_id in [&later_session, &session] {
            insert_session_row(&database.reader(), session_id.text().as_str(), None, None);
        }
        let due: Timestamp = "2030-01-01T10:00:00.000Z".parse().expect("a test instant");
        store
            .set(
                &later_session,
                note("later"),
                due + SignedDuration::from_mins(1),
            )
            .await
            .expect("the later reminder is kept");
        let set = store
            .set(&session, note("check CI"), due)
            .await
            .expect("the reminder is kept");
        writer
            .close(None)
            .await
            .expect("the writer closes with every write committed");

        let (reopened, _writer) = open_store(&database).await;
        let kept = reopened
            .reminders_of(session)
            .await
            .expect("the session's reminders read");
        assert_eq!(kept, vec![set.clone()]);
        assert_ne!(kept[0].set_at, kept[0].due_at);
        assert_eq!(
            reopened.earliest_due().await.expect("the earliest reads"),
            Some(set.due_at.clone())
        );

        let at_due = reopened.due_by(due).await.expect("the due read runs");
        assert_eq!(at_due, vec![set]);
        let before = reopened
            .due_by(due - SignedDuration::from_millis(1))
            .await
            .expect("the due read runs");
        assert_eq!(before, Vec::new());
    }
}
