//! The permission level a session runs at, a column of its `sessions` row: every process the daemon
//! opens or resumes for the session starts at it, and a level move stores it once the provider took
//! it.

use std::borrow::Cow;

use rusqlite::{Connection, OptionalExtension};
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::id::SessionId;

use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::{closed_word, text_column};

/// The statement storing the level a session moved to; the write refuses a session with no row.
pub(crate) fn permission_level_change_statement(
    session_id: &SessionId,
    permission_level: PermissionLevel,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(
            "UPDATE sessions SET permission_level = @permissionLevel WHERE id = @sessionId",
        ),
        bindings: StatementBindings::Named(vec![
            text_binding("@sessionId", session_id.text().as_str()),
            text_binding("@permissionLevel", <&'static str>::from(permission_level)),
        ]),
        expected_row_count: Some(1),
    }
}

/// The level the session runs at: YOLO for a session never moved. Fails when the read fails or the
/// stored text names no level.
pub(crate) fn read_session_permission_level(
    reader: &Connection,
    session_id: &SessionId,
) -> rusqlite::Result<PermissionLevel> {
    let level = reader
        .prepare_cached("SELECT permission_level FROM sessions WHERE id = ?")?
        .query_row([session_id.text().as_str()], |row| {
            text_column(row, 0, closed_word)
        })
        .optional()?;
    Ok(level.unwrap_or(PermissionLevel::Yolo))
}
