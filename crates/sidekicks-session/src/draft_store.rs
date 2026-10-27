//! Each session's unsent composer draft, one `session_drafts` row per session. The last write wins,
//! so a retried save needs no key; an empty draft deletes the row, which is how Send clears it.

use std::borrow::Cow;
use std::sync::Arc;

use rusqlite::types::Value;
use rusqlite::{OptionalExtension as _, named_params};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;

use crate::directory::lookups::{SessionWriteError, write_while_session_exists};
use sidekicks_ipc::registry::HandlerError;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::writer::DatabaseWriter;

/// The statements the store's reads run: the held draft.
pub const SESSION_DRAFT_STORE_STATEMENT_CAPACITY: usize = 1;

const SELECT_DRAFT_SQL: &str = "SELECT text FROM session_drafts WHERE session_id = @sessionId";

const UPSERT_DRAFT_SQL: &str = "INSERT INTO session_drafts (session_id, text, updated_at)
  VALUES (@sessionId, @text, @updatedAt)
  ON CONFLICT (session_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at";

const DELETE_DRAFT_SQL: &str = "DELETE FROM session_drafts WHERE session_id = @sessionId";

/// Why a draft was not read or stored; a refused store keeps nothing.
#[derive(Debug, thiserror::Error)]
pub enum SessionDraftError {
    /// The session is not one this daemon holds (`session.notFound`), or the write was not kept.
    #[error(transparent)]
    Write(#[from] SessionWriteError),
    /// SQLite refused the read.
    #[error("a read of a session's draft failed")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read's blocking task did not
    /// finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
}

impl From<SessionDraftError> for HandlerError {
    /// A store refused for its session answers as that refusal does; a failed read is a fault in
    /// the daemon.
    fn from(error: SessionDraftError) -> Self {
        match error {
            SessionDraftError::Write(write) => write.into(),
            fault @ (SessionDraftError::Database(_) | SessionDraftError::Pool(_)) => {
                Self::Internal(Box::new(fault))
            }
        }
    }
}

/// Reads each session's draft through the daemon's read pool and stores it through its writer.
pub struct SessionDraftStore {
    pool: Arc<DatabaseReadPool>,
    writer: Arc<DatabaseWriter>,
}

impl SessionDraftStore {
    /// The store reading through `pool` and writing through `writer`.
    pub fn new(pool: Arc<DatabaseReadPool>, writer: Arc<DatabaseWriter>) -> Self {
        Self { pool, writer }
    }

    /// The session's held draft, or the empty string when none is held. Fails with
    /// [`SessionDraftError::Database`] or [`SessionDraftError::Pool`] when the read does.
    pub async fn read(&self, session_id: SessionId) -> Result<String, SessionDraftError> {
        self.pool
            .read(ReadLength::Short, move |connection| {
                let draft = connection
                    .prepare_cached(SELECT_DRAFT_SQL)?
                    .query_row(
                        named_params! { "@sessionId": session_id.text().as_str() },
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?;
                Ok(draft.unwrap_or_default())
            })
            .await
    }

    /// Holds `text` as the session's draft, or clears the draft when `text` is empty, and answers
    /// when it was stored once committed. Fails with [`SessionDraftError::Write`]:
    /// `session.notFound` for a session this daemon holds no row for, or the write not kept.
    pub async fn write(
        &self,
        session_id: SessionId,
        text: String,
    ) -> Result<WireInstant, SessionDraftError> {
        let updated_at = WireInstant::now();
        let session_text = session_id.text();
        let change = if text.is_empty() {
            WriteStatement {
                sql: Cow::Borrowed(DELETE_DRAFT_SQL),
                bindings: StatementBindings::Named(vec![text_binding(
                    "@sessionId",
                    session_text.as_str(),
                )]),
                expected_row_count: None,
            }
        } else {
            WriteStatement {
                sql: Cow::Borrowed(UPSERT_DRAFT_SQL),
                bindings: StatementBindings::Named(vec![
                    text_binding("@sessionId", session_text.as_str()),
                    (Cow::Borrowed("@text"), Value::Text(text)),
                    text_binding("@updatedAt", updated_at.as_str()),
                ]),
                expected_row_count: None,
            }
        };
        write_while_session_exists(&self.writer, &session_id, change).await?;
        Ok(updated_at)
    }
}
