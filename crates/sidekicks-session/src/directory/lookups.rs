//! The lookups the session verbs and the sessions list share: whether a session has a directory
//! row, and the project it sits in. A session's project is the project of the attached mount its
//! latest workspace binds, or, before its workspace is bound (its project still cloning), the
//! project its create named; a chat's managed mount is no project, and a forgotten project is none.
//! Also the states of a session that has ended, closed or being purged, and a write kept only while
//! its session has a row.

use std::borrow::Cow;
use std::sync::LazyLock;

use rusqlite::{Connection, named_params};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_ipc::session_not_found::session_not_found;
use sidekicks_store::database::sql_list::sql_list_of;
use sidekicks_store::database::statement::{
    StatementBindings, StatementResult, WriteStatement, text_binding,
};
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};
use sidekicks_workspace::schema::MountOrigin;

/// The states of a session that has ended, closed or being purged, as a SQL list of quoted words
/// for a `state IN (…)` condition: such a session takes no message, ask or rule.
pub static ENDED_SESSION_STATES_SQL: LazyLock<String> = LazyLock::new(|| {
    sql_list_of([SessionState::Closed, SessionState::PurgeRequested].map(<&'static str>::from))
});

/// The subquery answering the project id of the session whose id `session_id_sql` reads (a bound
/// parameter such as `@sessionId`, or a column such as `s.id`), or NULL for a chat, a session whose
/// project was forgotten, or one not bound to a project yet.
pub fn session_project_sql(session_id_sql: &str) -> String {
    let attached = <&'static str>::from(MountOrigin::Attached);
    format!(
        "(SELECT project.id FROM projects AS project
    WHERE project.id = COALESCE(
      (SELECT mount.project_id
         FROM workspaces AS workspace
         JOIN repo_mounts AS mount ON mount.id = workspace.repo_mount_id
        WHERE workspace.session_id = {session_id_sql} AND mount.origin = '{attached}'
        ORDER BY workspace.created_at DESC, workspace.id DESC
        LIMIT 1),
      (SELECT request.project_id
         FROM session_create_requests AS request
        WHERE request.session_id = {session_id_sql})))"
    )
}

// Reads a row only while the session the `@sessionId` parameter names has a directory row.
const SESSION_EXISTS_SQL: &str = "SELECT 1 FROM sessions WHERE id = @sessionId";

/// Whether the session has a directory row, read on `reader`. Fails when SQLite refuses the read.
pub fn session_exists(reader: &Connection, session_id: &SessionId) -> rusqlite::Result<bool> {
    reader
        .prepare_cached(SESSION_EXISTS_SQL)?
        .exists(named_params! { "@sessionId": session_id.text().as_str() })
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
    /// The session is not one this daemon holds (`session.notFound`).
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
pub(crate) async fn write_while_session_exists(
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
