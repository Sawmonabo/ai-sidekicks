//! The lookups the session verbs and the sessions list share: whether a session has a directory
//! row, whether its create never finished, where it runs, the states of a session that has ended,
//! closed or being purged, and a write kept only while its session has a row.

use std::borrow::Cow;
use std::sync::LazyLock;

use rusqlite::{Connection, OptionalExtension as _, named_params};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::not_found::session::session_not_found;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_store::database::sql_list::sql_list_of;
use sidekicks_store::database::statement::{
    StatementBindings, StatementResult, WriteStatement, text_binding,
};
use sidekicks_store::database::stored_column::place_column;
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};

/// The states of a session that has ended, closed or being purged, as a SQL list of quoted words
/// for a `state IN (…)` condition: such a session takes no message, ask or rule.
pub static ENDED_SESSION_STATES_SQL: LazyLock<String> = LazyLock::new(|| {
    sql_list_of([SessionState::Closed, SessionState::PurgeRequested].map(<&'static str>::from))
});

// Reads a row only while the session the `@sessionId` parameter names has a directory row.
const SESSION_EXISTS_SQL: &str = "SELECT 1 FROM sessions WHERE id = @sessionId";

/// Whether the session has a directory row, read on `reader`. Fails when SQLite refuses the read.
pub fn session_exists(reader: &Connection, session_id: &SessionId) -> rusqlite::Result<bool> {
    reader
        .prepare_cached(SESSION_EXISTS_SQL)?
        .exists(named_params! { "@sessionId": session_id.text().as_str() })
}

/// A SQL condition that holds while the session `session_id_sql` names was never activated:
/// `session.activated` is written once, by its create's finish, so its create never finished.
pub fn never_activated_sql(session_id_sql: &str) -> String {
    format!(
        "NOT EXISTS (SELECT 1 FROM session_events WHERE session_id = {session_id_sql} AND type = '{}')",
        SessionEventType::SessionActivated.as_str()
    )
}

// A session left `provisioning` whose create never finished.
static UNFINISHED_CREATE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT 1 FROM sessions WHERE id = @sessionId AND state = '{}' AND {}",
        <&'static str>::from(SessionState::Provisioning),
        never_activated_sql("@sessionId")
    )
});

/// Whether the session is `provisioning` with a create that never finished, read on `reader`.
/// Fails when SQLite refuses the read.
pub fn is_unfinished_create(reader: &Connection, session_id: &SessionId) -> rusqlite::Result<bool> {
    reader
        .prepare_cached(&UNFINISHED_CREATE_SQL)?
        .exists(named_params! { "@sessionId": session_id.text().as_str() })
}

// The place the session the `@sessionId` parameter names runs in.
const SESSION_PLACE_SQL: &str = "SELECT place FROM sessions WHERE id = @sessionId";

/// Where the session runs, read on `reader`: `None` on macOS and Linux, and for a session with no
/// directory row. Fails when SQLite refuses the read or the stored place reads as no place.
pub fn read_session_place(
    reader: &Connection,
    session_id: &SessionId,
) -> rusqlite::Result<Option<Place>> {
    Ok(reader
        .prepare_cached(SESSION_PLACE_SQL)?
        .query_row(
            named_params! { "@sessionId": session_id.text().as_str() },
            |row| place_column(row, 0),
        )
        .optional()?
        .flatten())
}

/// Holds only while the session has a directory row: the write refuses and rolls back otherwise.
pub fn session_exists_statement(session_id: &SessionId) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(SESSION_EXISTS_SQL),
        bindings: StatementBindings::Named(vec![text_binding(
            "@sessionId",
            session_id.text().as_str(),
        )]),
        expected_row_count: Some(1),
    }
}

/// Why a write kept only while its session has a row was not kept.
#[derive(Debug, thiserror::Error)]
pub enum SessionWriteError {
    /// The session is not one this daemon holds (`session.notFound`), or a part of it the write
    /// names is not, such as a workflow run (`workflow.run.notFound`).
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// The write was not kept.
    #[error(transparent)]
    Write(#[from] WriteError),
}

impl From<SessionWriteError> for HandlerError {
    /// A session the daemon does not hold answers `session.notFound`; a write not kept is a fault
    /// in the daemon.
    fn from(error: SessionWriteError) -> Self {
        match error {
            SessionWriteError::Refused(refusal) => Self::Refused(refusal),
            SessionWriteError::Write(fault) => Self::Internal(Box::new(fault)),
        }
    }
}

/// Writes `change` only while `session_id` has a directory row, the check and the change in one
/// write, so a purge cannot land between them, and returns what `change` did. Fails with
/// [`SessionWriteError::Refused`] (`session.notFound`) for a session with no row, and with
/// [`SessionWriteError::Write`] when the write is not kept.
pub async fn write_while_session_exists(
    writer: &DatabaseWriter,
    session_id: &SessionId,
    change: WriteStatement,
) -> Result<StatementResult, SessionWriteError> {
    match writer
        .write(vec![session_exists_statement(session_id), change])
        .await
    {
        Ok(mut results) => Ok(results
            .pop()
            .expect("a committed write answers for each of its two statements")),
        Err(WriteError::Refused {
            statement_index: 0, ..
        }) => Err(session_not_found(session_id).into()),
        Err(error) => Err(error.into()),
    }
}
