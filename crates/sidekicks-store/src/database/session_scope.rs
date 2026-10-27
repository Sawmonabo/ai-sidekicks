//! A read that answers every session's rows or one session's: one SQL text built with and without
//! the session's condition, so the read's own predicate is written once.

use rusqlite::{Connection, Row, named_params};
use sidekicks_contracts::session::id::SessionId;

/// The two texts of one read: every session's rows, and only those of the session `@session_id`
/// names.
pub struct SessionScopedSql {
    every_session: String,
    one_session: String,
}

impl SessionScopedSql {
    /// The read `build` writes from the condition its rows take after its own: none, or
    /// `AND {session_column} = @session_id`.
    pub fn new(session_column: &str, build: impl Fn(&str) -> String) -> Self {
        Self {
            every_session: build(""),
            one_session: build(&format!("AND {session_column} = @session_id")),
        }
    }

    /// Runs the read on `reader`, each row through `row_of`: `session_id`'s rows, or every
    /// session's when it is `None`. Fails as SQLite or `row_of` does.
    pub fn query<T>(
        &self,
        reader: &Connection,
        session_id: Option<&SessionId>,
        row_of: impl FnMut(&Row<'_>) -> rusqlite::Result<T>,
    ) -> rusqlite::Result<Vec<T>> {
        match session_id {
            None => reader
                .prepare_cached(&self.every_session)?
                .query_map([], row_of)?
                .collect(),
            Some(session_id) => reader
                .prepare_cached(&self.one_session)?
                .query_map(
                    named_params! { "@session_id": session_id.text().as_str() },
                    row_of,
                )?
                .collect(),
        }
    }
}
