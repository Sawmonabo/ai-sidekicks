//! A session's tags: any number per session, across projects, kept as written and matched on their
//! case fold, so `Billing` and `billing` are one tag.

use std::borrow::Cow;
use std::sync::Arc;

use sidekicks_contracts::name_fold::fold_name;
use sidekicks_contracts::session::tags::{SessionTagListResponse, SessionTagRequest};
use sidekicks_contracts::tag::{Tag, TagList};
use sidekicks_contracts::wire::list::UniqueList;

use crate::directory::lookups::{SessionWriteError, write_while_session_exists};
use sidekicks_ipc::registry::HandlerError;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::text_column;
use sidekicks_store::database::writer::DatabaseWriter;

/// The statements the service's reads run: the tags in use.
pub const SESSION_TAG_SERVICE_STATEMENT_CAPACITY: usize = 1;

// A tag the session already holds under another casing keeps the casing it was first written in.
const ADD_TAG_SQL: &str = "INSERT INTO session_tags (session_id, tag, tag_folded)
  VALUES (@sessionId, @tag, @tagFolded)
  ON CONFLICT (session_id, tag_folded) DO NOTHING";

const REMOVE_TAG_SQL: &str =
    "DELETE FROM session_tags WHERE session_id = @sessionId AND tag_folded = @tagFolded";

// One spelling per tag in use, in the fold's order.
const TAGS_IN_USE_SQL: &str =
    "SELECT MIN(tag) AS tag FROM session_tags GROUP BY tag_folded ORDER BY tag_folded";

/// A stored tag that is not a tag, which only a write outside the tag verbs can leave.
#[derive(Debug, thiserror::Error)]
#[error("the stored tag is not a tag")]
pub(crate) struct NotATag;

/// Why a tag change or the tags in use failed; a refused change keeps nothing.
#[derive(Debug, thiserror::Error)]
pub enum SessionTagError {
    /// The session is not one this daemon holds (`session.notFound`), or the write was not kept.
    #[error(transparent)]
    Write(#[from] SessionWriteError),
    /// SQLite refused the read, or a stored tag is not a tag.
    #[error("a read of the tags in use failed")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read's blocking task did not
    /// finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
}

impl From<SessionTagError> for HandlerError {
    /// A change refused for its session answers as that refusal does; a failed read is a fault in
    /// the daemon.
    fn from(error: SessionTagError) -> Self {
        match error {
            SessionTagError::Write(write) => write.into(),
            fault @ (SessionTagError::Database(_) | SessionTagError::Pool(_)) => {
                Self::Internal(Box::new(fault))
            }
        }
    }
}

/// Adds, removes and lists session tags, reading through the daemon's read pool and writing
/// through its writer.
pub struct SessionTagService {
    pool: Arc<DatabaseReadPool>,
    writer: Arc<DatabaseWriter>,
}

impl SessionTagService {
    /// The service reading through `pool` and writing through `writer`.
    pub fn new(pool: Arc<DatabaseReadPool>, writer: Arc<DatabaseWriter>) -> Self {
        Self { pool, writer }
    }

    /// Tags the session; a tag it already holds, ignoring case, stays as it is. Fails with
    /// [`SessionTagError::Write`]: `session.notFound` for an unknown session, or the write not
    /// kept.
    pub async fn add(&self, request: &SessionTagRequest) -> Result<(), SessionTagError> {
        let session_text = request.session_id.text();
        let tag_folded = fold_name(request.tag.as_str());
        write_while_session_exists(
            &self.writer,
            &request.session_id,
            WriteStatement {
                sql: Cow::Borrowed(ADD_TAG_SQL),
                bindings: StatementBindings::Named(vec![
                    text_binding("@sessionId", session_text.as_str()),
                    text_binding("@tag", request.tag.as_str()),
                    text_binding("@tagFolded", &tag_folded),
                ]),
                expected_row_count: None,
            },
        )
        .await
        .map_err(SessionTagError::from)?;
        Ok(())
    }

    /// Removes the tag from the session, matched ignoring case; a tag it does not hold is already
    /// gone. Fails as [`SessionTagService::add`] does.
    pub async fn remove(&self, request: &SessionTagRequest) -> Result<(), SessionTagError> {
        let session_text = request.session_id.text();
        let tag_folded = fold_name(request.tag.as_str());
        write_while_session_exists(
            &self.writer,
            &request.session_id,
            WriteStatement {
                sql: Cow::Borrowed(REMOVE_TAG_SQL),
                bindings: StatementBindings::Named(vec![
                    text_binding("@sessionId", session_text.as_str()),
                    text_binding("@tagFolded", &tag_folded),
                ]),
                expected_row_count: None,
            },
        )
        .await
        .map_err(SessionTagError::from)?;
        Ok(())
    }

    /// The tags in use across every session, for `Add tag` to suggest. Fails with
    /// [`SessionTagError::Database`] for a stored tag that is not a tag or a refused read, and with
    /// [`SessionTagError::Pool`] when the read does not reach a connection.
    pub async fn list(&self) -> Result<SessionTagListResponse, SessionTagError> {
        self.pool
            .read(ReadLength::Long, |connection| {
                let tags = connection
                    .prepare_cached(TAGS_IN_USE_SQL)?
                    .query_map([], |row| {
                        text_column(row, 0, |text| Tag::new(text).ok_or(NotATag))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(SessionTagListResponse {
                    tags: TagList(UniqueList::new(tags).expect("a tag list has no count bound")),
                })
            })
            .await
    }
}
