//! A session's own console settings, over the `session_console_state` table: the advisor a session
//! on a provider that offers an advisor keeps from its creation, changed only by the session's
//! advisor command, and the Build or Plan mode the provider last took. Every process the daemon
//! starts for the session reads the advisor at launch, and a restart resumes in the mode.

use std::borrow::Cow;

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension};
use sidekicks_contracts::session::controls::methods::SessionMode;
use sidekicks_contracts::session::id::SessionId;

use crate::database::statement::{StatementBindings, WriteStatement};
use crate::session::stored_column::{closed_word, text_column};

/// The row a session on a provider that offers an advisor is born with, its advisor copied from
/// the machine's default; it binds the session id, the advisor and the time, in that order.
pub(crate) const INSERT_CONSOLE_STATE_SQL: &str = "INSERT INTO session_console_state
  (session_id, advisor_model, updated_at) VALUES (?, ?, ?)";

// A session born on a provider without an advisor has no row until its first change needs one.
const UPSERT_ADVISOR_MODEL_SQL: &str = "INSERT INTO session_console_state
  (session_id, advisor_model, updated_at) VALUES (@sessionId, @advisorModel, @updatedAt)
  ON CONFLICT(session_id) DO UPDATE
    SET advisor_model = excluded.advisor_model, updated_at = excluded.updated_at";

const UPSERT_SESSION_MODE_SQL: &str = "INSERT INTO session_console_state
  (session_id, session_mode, updated_at) VALUES (@sessionId, @sessionMode, @updatedAt)
  ON CONFLICT(session_id) DO UPDATE
    SET session_mode = excluded.session_mode, updated_at = excluded.updated_at";

/// The statement storing the advisor the session's advisor command set, `None` for off,
/// committed in its event's own write.
pub(crate) fn advisor_model_change_statement(
    session_id: &SessionId,
    advisor_model: Option<&str>,
    updated_at: &str,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(UPSERT_ADVISOR_MODEL_SQL),
        bindings: StatementBindings::Named(vec![
            (
                Cow::Borrowed("@sessionId"),
                Value::Text(session_id.as_str().to_owned()),
            ),
            (
                Cow::Borrowed("@advisorModel"),
                advisor_model.map_or(Value::Null, |model| Value::Text(model.to_owned())),
            ),
            (
                Cow::Borrowed("@updatedAt"),
                Value::Text(updated_at.to_owned()),
            ),
        ]),
        expected_row_count: None,
    }
}

/// The session's own advisor, `None` when it is off or the session never had one. Fails when the
/// read fails.
pub(crate) fn read_session_advisor_model(
    reader: &Connection,
    session_id: &SessionId,
) -> rusqlite::Result<Option<String>> {
    let advisor_model = reader
        .prepare_cached("SELECT advisor_model FROM session_console_state WHERE session_id = ?")?
        .query_row([session_id.as_str()], |row| row.get::<_, Option<String>>(0))
        .optional()?;
    Ok(advisor_model.flatten())
}

/// The statement storing the mode a `session.modeUpdate` moved the provider to.
pub(crate) fn session_mode_change_statement(
    session_id: &SessionId,
    session_mode: SessionMode,
    updated_at: &str,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(UPSERT_SESSION_MODE_SQL),
        bindings: StatementBindings::Named(vec![
            (
                Cow::Borrowed("@sessionId"),
                Value::Text(session_id.as_str().to_owned()),
            ),
            (
                Cow::Borrowed("@sessionMode"),
                Value::Text(<&'static str>::from(session_mode).to_owned()),
            ),
            (
                Cow::Borrowed("@updatedAt"),
                Value::Text(updated_at.to_owned()),
            ),
        ]),
        expected_row_count: None,
    }
}

/// The mode the session was last moved to, Build for a session never moved. Fails when the read
/// fails or the stored text names no mode.
pub(crate) fn read_session_mode(
    reader: &Connection,
    session_id: &SessionId,
) -> rusqlite::Result<SessionMode> {
    let session_mode = reader
        .prepare_cached("SELECT session_mode FROM session_console_state WHERE session_id = ?")?
        .query_row([session_id.as_str()], |row| {
            text_column(row, 0, closed_word)
        })
        .optional()?;
    Ok(session_mode.unwrap_or(SessionMode::Build))
}
