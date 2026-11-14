//! The conversation cuts recorded under an undo's key, written in the cut's own rollback write, so
//! a retry under that key after an outcome the daemon could not read learns the cut applied and
//! never cuts again.

use std::borrow::Cow;
use std::sync::LazyLock;

use rusqlite::{Connection, OptionalExtension as _, named_params};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_store::database::statement::{
    DATABASE_NOW_SQL, StatementBindings, WriteStatement, text_binding,
};

static RECORD_CUT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO session_restore_cuts (session_id, client_idempotency_key, created_at)
  VALUES (@sessionId, @key, {DATABASE_NOW_SQL})"
    )
});

const RECORDED_CUT_SQL: &str = "SELECT 1 FROM session_restore_cuts
  WHERE session_id = @sessionId AND client_idempotency_key = @key";

/// The statement that records the conversation cut of `session_id`'s undo `undo_key`; a second
/// one under the same key is refused, so a write holding it fails whole.
pub fn record_cut_statement(session_id: SessionId, undo_key: &ClientUuid) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(RECORD_CUT_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@sessionId", session_id.text().as_str()),
            text_binding("@key", undo_key.as_str()),
        ]),
        expected_row_count: Some(1),
    }
}

/// Whether `session_id`'s undo `undo_key` already cut the conversation. Fails as SQLite does.
pub fn is_cut_recorded(
    connection: &Connection,
    session_id: SessionId,
    undo_key: &ClientUuid,
) -> rusqlite::Result<bool> {
    Ok(connection
        .prepare_cached(RECORDED_CUT_SQL)?
        .query_row(
            named_params! {
                "@sessionId": session_id.text().as_str(),
                "@key": undo_key.as_str(),
            },
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}
