//! A session's working folder: the root of its newest workspace in a state that carries a live
//! root. The `@` file search lists it and every shell of the session starts in it.

use std::path::PathBuf;
use std::sync::LazyLock;

use rusqlite::{Connection, OptionalExtension};
use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::mount::WorkspaceState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionShape;
use strum::VariantArray;

use crate::database::sql_list::sql_list_of;
use crate::database::stored_column::{closed_word, optional_text_column, text_column};
use crate::ipc::domain_error::DomainError;
use crate::session::not_found::session_not_found;
use crate::workspace::projector::is_probe_bearing;

// The session's shape, the root of its newest workspace whose state carries a live root, and the
// session's place.
static WORKING_FOLDER_SQL: LazyLock<String> = LazyLock::new(|| {
    let probe_bearing_states = sql_list_of(
        WorkspaceState::VARIANTS
            .iter()
            .copied()
            .filter(|&state| is_probe_bearing(state))
            .map(<&'static str>::from),
    );
    format!(
        "SELECT shape,
         (SELECT fs_root FROM workspaces
           WHERE session_id = sessions.id AND fs_root IS NOT NULL
             AND state IN ({probe_bearing_states})
           ORDER BY created_at DESC, id DESC
           LIMIT 1) AS fs_root,
         place
    FROM sessions
   WHERE id = ?"
    )
});

/// A session's shape, its working folder, `None` while no workspace root is in place, and the
/// place the folder is in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SessionWorkingFolder {
    /// What the session is bound to.
    pub(crate) shape: SessionShape,
    /// The root its shells start in and its file search lists.
    pub(crate) working_folder: Option<PathBuf>,
    /// Where the session works: `None` on macOS and Linux, Windows itself or a WSL 2
    /// distribution on Windows, so every git call on the folder runs there.
    pub(crate) place: Option<Place>,
}

/// Why a session's working folder could not be read.
#[derive(Debug, thiserror::Error)]
pub(crate) enum WorkingFolderReadError {
    /// The session is not one this daemon holds (`session.notFound`).
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// The read failed, or the stored shape names no shape.
    #[error("the read of a session's working folder failed")]
    Database(#[from] rusqlite::Error),
}

/// Reads the working folder of `session_id` on `reader`. Fails with
/// [`WorkingFolderReadError::Refused`] (`session.notFound`) for a session this daemon holds no row
/// for, and with [`WorkingFolderReadError::Database`] when the read fails.
pub(crate) fn read_working_folder(
    reader: &Connection,
    session_id: &SessionId,
) -> Result<SessionWorkingFolder, WorkingFolderReadError> {
    reader
        .prepare_cached(WORKING_FOLDER_SQL.as_str())?
        .query_row([session_id.text().as_str()], |row| {
            Ok(SessionWorkingFolder {
                shape: text_column(row, 0, closed_word)?,
                working_folder: row.get::<_, Option<String>>(1)?.map(PathBuf::from),
                // The column holds the place's wire JSON.
                place: optional_text_column(row, 2, |text| serde_json::from_str::<Place>(&text))?,
            })
        })
        .optional()?
        .ok_or_else(|| session_not_found(session_id).into())
}
