//! A session's own console settings, over the `session_console_state` table: the advisor a session
//! on a provider that offers an advisor keeps from its creation, changed only by the session's
//! advisor command, the Build or Plan mode the provider last took, and the session's own bound on
//! the steps one turn may take. Every process the daemon starts for the session reads the advisor
//! at launch, a restart resumes in the mode, and `session.read` answers with the step bound.

use std::borrow::Cow;

use rusqlite::types::Type;
use rusqlite::{Connection, OptionalExtension};
use sidekicks_contracts::session::controls::methods::SessionMode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;

use crate::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};
use crate::database::stored_column::{closed_word, safe_int_column, text_column};

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
            text_binding("@sessionId", session_id.text().as_str()),
            nullable_text_binding("@advisorModel", advisor_model),
            text_binding("@updatedAt", updated_at),
        ]),
        expected_row_count: None,
    }
}

/// The session's own advisor: `None` when the session never had one, `Some(None)` when it is off.
/// Fails when the read fails.
#[expect(
    clippy::option_option,
    reason = "a session with no advisor of its own differs from one whose advisor is off"
)]
pub(crate) fn read_session_advisor_model(
    reader: &Connection,
    session_id: &SessionId,
) -> rusqlite::Result<Option<Option<String>>> {
    reader
        .prepare_cached("SELECT advisor_model FROM session_console_state WHERE session_id = ?")?
        .query_row([session_id.text().as_str()], |row| {
            row.get::<_, Option<String>>(0)
        })
        .optional()
}

/// The statement storing the mode a `session.mode.update` moved the provider to.
pub(crate) fn session_mode_change_statement(
    session_id: &SessionId,
    session_mode: SessionMode,
    updated_at: &str,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(UPSERT_SESSION_MODE_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@sessionId", session_id.text().as_str()),
            text_binding("@sessionMode", <&'static str>::from(session_mode)),
            text_binding("@updatedAt", updated_at),
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
        .query_row([session_id.text().as_str()], |row| {
            text_column(row, 0, closed_word)
        })
        .optional()?;
    Ok(session_mode.unwrap_or(SessionMode::Build))
}

/// The session's own bound on the steps one turn may take, `None` where the person set none or the
/// session has no row. Fails when the read fails, and with
/// `rusqlite::Error::FromSqlConversionFailure`, naming the value, for a stored bound outside 1 to
/// 2^53 − 1.
pub(crate) fn read_session_max_steps_per_turn(
    reader: &Connection,
    session_id: &SessionId,
) -> rusqlite::Result<Option<SafeInt<1>>> {
    let max_steps_per_turn = reader
        .prepare_cached(
            "SELECT max_steps_per_turn FROM session_console_state WHERE session_id = ?",
        )?
        .query_row([session_id.text().as_str()], |row| {
            if row.get_ref(0)?.data_type() == Type::Null {
                Ok(None)
            } else {
                safe_int_column::<1>(row, 0).map(Some)
            }
        })
        .optional()?;
    Ok(max_steps_per_turn.flatten())
}
