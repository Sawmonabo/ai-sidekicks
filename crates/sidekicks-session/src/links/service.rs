//! The person's `related` links: added on purpose between two sessions and the one kind a person
//! removes. A pair holds at most one, whichever session it was added from.

use std::borrow::Cow;
use std::sync::{Arc, LazyLock};

use rusqlite::named_params;
use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::links::{SessionLinkKind, SessionLinkRequest};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_ipc::session_not_found::session_not_found;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::statement::{
    DATABASE_NOW_SQL, StatementBindings, StatementResult, WriteStatement, text_binding,
};
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};

use crate::directory::lookups::session_exists_statement;
use crate::related::ranking::SessionRelatedRanking;

/// The statements the service's reads run: whether a pair holds any link.
pub const SESSION_LINK_SERVICE_STATEMENT_CAPACITY: usize = 1;

static ADD_RELATED_LINK_SQL: LazyLock<String> = LazyLock::new(|| {
    let related = <&'static str>::from(SessionLinkKind::Related);
    format!(
        "INSERT INTO session_links
    (source_session_id, target_session_id, kind, use_count, first_at, last_at)
  SELECT @sessionId, @targetSessionId, '{related}', 1, {DATABASE_NOW_SQL}, {DATABASE_NOW_SQL}
   WHERE NOT EXISTS (SELECT 1 FROM session_links
                      WHERE source_session_id = @targetSessionId
                        AND target_session_id = @sessionId
                        AND kind = '{related}')
  ON CONFLICT (source_session_id, target_session_id, kind) DO NOTHING"
    )
});

static REMOVE_RELATED_LINK_SQL: LazyLock<String> = LazyLock::new(|| {
    let related = <&'static str>::from(SessionLinkKind::Related);
    format!(
        "DELETE FROM session_links
  WHERE kind = '{related}'
    AND ((source_session_id = @sessionId AND target_session_id = @targetSessionId)
      OR (source_session_id = @targetSessionId AND target_session_id = @sessionId))"
    )
});

const PAIR_HAS_LINK_SQL: &str = "SELECT 1 FROM session_links
  WHERE (source_session_id = @sessionId AND target_session_id = @targetSessionId)
     OR (source_session_id = @targetSessionId AND target_session_id = @sessionId)
  LIMIT 1";

// The positions of the guards in a link write.
const SESSION_GUARD_INDEX: usize = 0;
const TARGET_GUARD_INDEX: usize = 1;

/// Why a link change failed; a refused change keeps nothing.
#[derive(Debug, thiserror::Error)]
pub enum SessionLinkError {
    /// Either session is not one this daemon holds (`session.notFound`), or the pair is linked
    /// only by kinds an event recorded (`session.link.notRemovable`).
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// The write was not kept.
    #[error(transparent)]
    Write(#[from] WriteError),
    /// SQLite refused the read of the pair's links.
    #[error("a read of the pair's links failed")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read's blocking task did not
    /// finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
}

impl From<SessionLinkError> for HandlerError {
    /// A refused change answers by its code; a write not kept or a failed read is a fault in the
    /// daemon.
    fn from(error: SessionLinkError) -> Self {
        match error {
            SessionLinkError::Refused(refusal) => Self::Refused(refusal),
            fault @ (SessionLinkError::Write(_)
            | SessionLinkError::Database(_)
            | SessionLinkError::Pool(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

/// Adds and removes the `related` link between two sessions, reading through the daemon's read
/// pool and writing through its writer; a committed change has the related ranking re-score both.
pub struct SessionLinkService {
    pool: Arc<DatabaseReadPool>,
    writer: Arc<DatabaseWriter>,
    related_ranking: Arc<SessionRelatedRanking>,
}

impl SessionLinkService {
    /// The service reading through `pool`, writing through `writer` and re-scoring through
    /// `related_ranking`.
    pub fn new(
        pool: Arc<DatabaseReadPool>,
        writer: Arc<DatabaseWriter>,
        related_ranking: Arc<SessionRelatedRanking>,
    ) -> Self {
        Self {
            pool,
            writer,
            related_ranking,
        }
    }

    /// Links the two sessions as related; a pair already related stays as it is. Fails with
    /// [`SessionLinkError::Refused`] (`session.notFound`) when either session is unknown, and with
    /// [`SessionLinkError::Write`] when the write is not kept.
    pub async fn add(&self, request: &SessionLinkRequest) -> Result<(), SessionLinkError> {
        let results = self
            .write_for_pair(request, ADD_RELATED_LINK_SQL.as_str())
            .await?;
        if is_link_changed(&results) {
            self.rescore_pair(request);
        }
        Ok(())
    }

    /// Removes the pair's `related` link, from either side; a pair with no link is left as it is.
    /// Fails with [`SessionLinkError::Refused`]: `session.link.notRemovable` when the pair is
    /// linked only by kinds an event recorded, `session.notFound` for an unknown session; and as
    /// the write or the read fails.
    pub async fn remove(&self, request: &SessionLinkRequest) -> Result<(), SessionLinkError> {
        let results = self
            .write_for_pair(request, REMOVE_RELATED_LINK_SQL.as_str())
            .await?;
        if is_link_changed(&results) {
            self.rescore_pair(request);
            return Ok(());
        }
        // Nothing was written, so this read decides only which answer the person gets.
        let session_text = request.session_id.text();
        let target_text = request.target_session_id.text();
        let has_link = self
            .pool
            .read(ReadLength::Short, move |connection| {
                let has_link =
                    connection
                        .prepare_cached(PAIR_HAS_LINK_SQL)?
                        .exists(named_params! {
                            "@sessionId": session_text.as_str(),
                            "@targetSessionId": target_text.as_str(),
                        })?;
                Ok::<_, SessionLinkError>(has_link)
            })
            .await?;
        if has_link {
            return Err(DomainError::new(
                "This link records what happened and stays.",
                RefusalCode::SessionLinkNotRemovable,
            )
            .with_detail(json!({
                "sessionId": request.session_id,
                "targetSessionId": request.target_session_id,
            }))
            .into());
        }
        Ok(())
    }

    // Runs `change_sql` in one write behind both sessions' existence guards.
    async fn write_for_pair(
        &self,
        request: &SessionLinkRequest,
        change_sql: &'static str,
    ) -> Result<Vec<StatementResult>, SessionLinkError> {
        let change = WriteStatement {
            sql: Cow::Borrowed(change_sql),
            bindings: StatementBindings::Named(vec![
                text_binding("@sessionId", request.session_id.text().as_str()),
                text_binding(
                    "@targetSessionId",
                    request.target_session_id.text().as_str(),
                ),
            ]),
            expected_row_count: None,
        };
        let statements = vec![
            session_exists_statement(&request.session_id),
            session_exists_statement(&request.target_session_id),
            change,
        ];
        match self.writer.write(statements).await {
            Ok(results) => Ok(results),
            Err(WriteError::Refused {
                statement_index: SESSION_GUARD_INDEX,
                ..
            }) => Err(session_not_found(&request.session_id).into()),
            Err(WriteError::Refused {
                statement_index: TARGET_GUARD_INDEX,
                ..
            }) => Err(session_not_found(&request.target_session_id).into()),
            Err(error) => Err(error.into()),
        }
    }

    fn rescore_pair(&self, request: &SessionLinkRequest) {
        self.related_ranking
            .rescore_around([request.session_id, request.target_session_id]);
    }
}

// Whether the write's change, its last statement, added or removed the link.
fn is_link_changed(results: &[StatementResult]) -> bool {
    results.last().is_some_and(|change| change.row_count == 1)
}
