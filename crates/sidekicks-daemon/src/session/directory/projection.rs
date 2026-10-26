//! The session directory row as a projection of the log, which a rebuild replaces: the row's
//! event-derived columns are folded from the session's events and written over the row, or into a
//! new one where the row was lost. The row is never deleted, so the columns services write, its
//! group among them, outlive the rebuild, and the search index keeps the rows it holds by the row's
//! rowid.

use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::session::id::SessionId;

use crate::database::statement::WriteStatement;
use crate::error_description::describe_error;
use crate::events::projection::{
    ProjectionContradiction, SessionProjection, SessionProjectionFold,
};
use crate::session::directory::row::{
    DirectoryEvent, directory_row_statement, fold_directory_row, open_directory_row,
};
use crate::session::records::SessionDirectoryRow;

/// The `sessions` row as a rebuild replaces it. Almost every event moves the row's last activity,
/// so the fold reads every registered event type.
pub(crate) struct SessionDirectoryProjection;

impl SessionProjection for SessionDirectoryProjection {
    fn name(&self) -> &'static str {
        "sessions"
    }

    fn event_types(&self) -> &[SessionEventType] {
        SessionEventType::ALL
    }

    // The row is written over, never deleted, so the rebuild clears nothing.
    fn clear_statements(&self, _session_id: &SessionId) -> Vec<WriteStatement> {
        Vec::new()
    }

    fn fold(&self, _session_id: &SessionId) -> Box<dyn SessionProjectionFold> {
        Box::new(DirectoryFold { row: None })
    }
}

// The row as folded so far; `None` until the log's `session.created`.
struct DirectoryFold {
    row: Option<SessionDirectoryRow>,
}

impl SessionProjectionFold for DirectoryFold {
    // The log opens at `session.created` and names it once; a later event writes the row only
    // when it changed a column.
    fn apply(
        &mut self,
        envelope: &EventEnvelope,
        _event: &SessionEvent,
        statements: &mut Vec<WriteStatement>,
    ) -> Result<(), ProjectionContradiction> {
        let event = DirectoryEvent::from(envelope);
        let next = match &self.row {
            None => open_directory_row(&event),
            Some(row) => fold_directory_row(row, &event),
        }
        .map_err(|error| ProjectionContradiction(describe_error(&error)))?;
        if self.row.as_ref() == Some(&next) {
            return Ok(());
        }
        statements.push(directory_row_statement(&next));
        self.row = Some(next);
        Ok(())
    }
}
