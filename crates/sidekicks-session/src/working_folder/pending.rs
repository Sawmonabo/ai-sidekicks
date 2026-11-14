//! The pending move a session's row holds: its read, and each change to it, written in one write
//! with the `session.pendingWorkingFolder.changed` that carries the move waiting after it, so every
//! window of the session follows the row. A write that changes nothing appends nothing.

use std::borrow::Cow;

use notify::Watcher;
use rusqlite::{OptionalExtension, named_params};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::repo::mount::WorkspaceId;
use sidekicks_contracts::session::directory::SessionPendingWorkingFolderChangedPayload;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionPendingWorkingFolder;
use sidekicks_contracts::wire::id::UuidText;
use sidekicks_ipc::not_found::session::session_not_found;
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};
use sidekicks_store::database::stored_column::text_column;
use sidekicks_store::events::session::append_lock::SessionAppendHold;
use sidekicks_store::events::session::appender::{
    SessionEventAppendError, SessionEventDraft, SessionEventEmitError, SessionEventLinkage,
};

use super::{SessionWorkingFolderError, SessionWorkingFolders};
use crate::directory::lookups::session_exists_statement;

const SELECT_PENDING_SQL: &str =
    "SELECT pending_working_folder, pending_working_folder_workspace_id
  FROM sessions WHERE id = @session_id";

// Writes the move only where it differs from the one stored, so a request for the move already
// waiting, or a clear with none waiting, writes nothing.
const STORE_PENDING_SQL: &str = "UPDATE sessions
  SET pending_working_folder = @path, pending_working_folder_workspace_id = @workspace_id
  WHERE id = @session_id
    AND (pending_working_folder IS NOT @path
         OR pending_working_folder_workspace_id IS NOT @workspace_id)";

// Clears the pending move only while it still names `@path` and `@workspace_id`, so a newer
// request survives.
const CLEAR_PENDING_AT_SQL: &str = "UPDATE sessions
  SET pending_working_folder = NULL, pending_working_folder_workspace_id = NULL
  WHERE id = @session_id AND pending_working_folder = @path
    AND pending_working_folder_workspace_id = @workspace_id";

// Where a store's write puts the session's check, refused for a session with no row.
const STORE_SESSION_CHECK_INDEX: usize = 0;

// Where a store's write puts the change, refused when the row already holds that move.
const STORE_CHANGE_INDEX: usize = 1;

/// Where a write that clears a move as read puts the clear, refused when another caller cleared or
/// replaced the move first.
pub(super) const CLEAR_INDEX: usize = 0;

/// A move held on the session's row: the folder, as stored, and the workspace it was asked for.
pub(super) struct PendingMove {
    /// The folder, as stored.
    pub(super) path: String,
    /// The workspace it was asked for.
    pub(super) workspace_id: WorkspaceId,
}

/// The clear of a move as read and the event saying none waits, which go in one write.
pub(super) struct PendingClear {
    /// The clear, which holds only while the row still names the move.
    pub(super) statement: WriteStatement,
    /// The event saying no move waits.
    pub(super) event: SessionEventDraft,
}

impl PendingClear {
    /// The clear of `pending`, the session's move as read. Fails when the event cannot be drafted.
    pub(super) fn of(
        session_id: SessionId,
        pending: &PendingMove,
    ) -> Result<Self, SessionEventEmitError> {
        Ok(Self {
            statement: WriteStatement {
                sql: Cow::Borrowed(CLEAR_PENDING_AT_SQL),
                bindings: StatementBindings::Named(vec![
                    text_binding("@session_id", session_id.text().as_str()),
                    text_binding("@path", &pending.path),
                    text_binding("@workspace_id", pending.workspace_id.text().as_str()),
                ]),
                expected_row_count: Some(1),
            },
            event: pending_changed(session_id, None)?,
        })
    }
}

impl<W: Watcher + Send + Sync + 'static> SessionWorkingFolders<W> {
    /// `None` for a session with no row, else its pending move.
    pub(super) async fn read_pending(
        &self,
        session_id: SessionId,
    ) -> Result<Option<Option<PendingMove>>, SessionWorkingFolderError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok(connection
                    .prepare_cached(SELECT_PENDING_SQL)?
                    .query_row(
                        named_params! { "@session_id": session_id.text().as_str() },
                        |row| {
                            let Some(path) = row.get::<_, Option<String>>(0)? else {
                                return Ok(None);
                            };
                            Ok(Some(PendingMove {
                                path,
                                workspace_id: text_column(row, 1, |text| WorkspaceId::new(&text))?,
                            }))
                        },
                    )
                    .optional()?)
            })
            .await
    }

    /// Stores `pending`, a folder and the workspace it was asked for, as the session's pending
    /// move, or clears it with `None`, with the event saying so; the move already stored is left
    /// with no event. Refuses `session.notFound` for a session purged meanwhile.
    pub(super) async fn store_pending(
        &self,
        session_id: SessionId,
        pending: Option<(&FilesystemPath, WorkspaceId)>,
    ) -> Result<(), SessionWorkingFolderError> {
        let workspace_text = pending.map(|(_, workspace_id)| workspace_id.text());
        let change = WriteStatement {
            sql: Cow::Borrowed(STORE_PENDING_SQL),
            bindings: StatementBindings::Named(vec![
                text_binding("@session_id", session_id.text().as_str()),
                nullable_text_binding("@path", pending.map(|(path, _)| path.as_str())),
                nullable_text_binding(
                    "@workspace_id",
                    workspace_text.as_ref().map(UuidText::as_str),
                ),
            ]),
            expected_row_count: Some(1),
        };
        let event = pending_changed(session_id, pending.map(|(path, _)| path.clone()))?;
        let prelude = vec![session_exists_statement(&session_id), change];
        match self.append_pending(event, prelude, None).await {
            Ok(()) => Ok(()),
            Err(error) => match error.refused_statement_index() {
                Some(STORE_SESSION_CHECK_INDEX) => Err(session_not_found(&session_id).into()),
                Some(STORE_CHANGE_INDEX) => Ok(()),
                Some(_) | None => Err(SessionEventEmitError::from(error).into()),
            },
        }
    }

    /// Clears `pending`, the session's pending move as read, with the event saying so, under
    /// `append_hold` where the caller holds the session; `false` when another caller cleared or
    /// replaced it first, so nothing was written.
    pub(super) async fn clear_pending(
        &self,
        session_id: SessionId,
        pending: &PendingMove,
        append_hold: Option<&SessionAppendHold>,
    ) -> Result<bool, SessionWorkingFolderError> {
        let clear = PendingClear::of(session_id, pending)?;
        match self
            .append_pending(clear.event, vec![clear.statement], append_hold)
            .await
        {
            Ok(()) => Ok(true),
            Err(error) if error.refused_statement_index() == Some(CLEAR_INDEX) => Ok(false),
            Err(error) => Err(SessionEventEmitError::from(error).into()),
        }
    }

    // Appends `event` after `prelude` in one write, under `append_hold` when given.
    async fn append_pending(
        &self,
        event: SessionEventDraft,
        prelude: Vec<WriteStatement>,
        append_hold: Option<&SessionAppendHold>,
    ) -> Result<(), SessionEventAppendError> {
        let linkage = SessionEventLinkage {
            transactional_prelude: prelude,
            ..SessionEventLinkage::default()
        };
        match append_hold {
            Some(hold) => self.appender.append_held(hold, event, linkage).await?,
            None => self.appender.append(event, linkage).await?,
        };
        Ok(())
    }
}

// `session.pendingWorkingFolder.changed` on the session's log, naming the move that waits now.
fn pending_changed(
    session_id: SessionId,
    path: Option<FilesystemPath>,
) -> Result<SessionEventDraft, SessionEventEmitError> {
    let payload = SessionPendingWorkingFolderChangedPayload {
        session_id,
        pending_working_folder: path.map(|path| SessionPendingWorkingFolder { path }),
    };
    Ok(SessionEventDraft::of_session(
        session_id,
        &SessionEvent::SessionPendingWorkingFolderChanged(payload),
    )?)
}
