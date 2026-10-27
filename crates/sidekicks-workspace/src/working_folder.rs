//! A session's working folder: the root of its newest workspace in a state that carries a live
//! root, and the repository it belongs to while its mount is attached. The `@` file search lists
//! it, every shell of the session starts in it, and the worktree watch watches it.

use std::path::PathBuf;
use std::sync::LazyLock;

use rusqlite::{Connection, OptionalExtension};
use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::mount::{RepoMountId, RepoMountState, WorkspaceState};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionShape;
use strum::VariantArray;

use crate::projector::is_probe_bearing;
use crate::schema::MountOrigin;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::session_not_found::session_not_found;
use sidekicks_store::database::sql_list::sql_list_of;
use sidekicks_store::database::stored_column::{closed_word, optional_text_column, text_column};

// The session's shape, the root of its newest workspace whose state carries a live root, the
// session's place, and that workspace's mount while it is attached.
static WORKING_FOLDER_SQL: LazyLock<String> = LazyLock::new(|| {
    let probe_bearing_states = sql_list_of(
        WorkspaceState::VARIANTS
            .iter()
            .copied()
            .filter(|&state| is_probe_bearing(state))
            .map(<&'static str>::from),
    );
    let attached = <&'static str>::from(RepoMountState::Attached);
    format!(
        "SELECT sessions.shape, workspace.fs_root, sessions.place,
         mount.id, mount.canonical_root, mount.origin
    FROM sessions
    LEFT JOIN workspaces AS workspace
      ON workspace.id = (SELECT id FROM workspaces
                          WHERE session_id = sessions.id AND fs_root IS NOT NULL
                            AND state IN ({probe_bearing_states})
                          ORDER BY created_at DESC, id DESC
                          LIMIT 1)
    LEFT JOIN repo_mounts AS mount
      ON mount.id = workspace.repo_mount_id AND mount.state = '{attached}'
   WHERE sessions.id = ?"
    )
});

/// A session's shape, its working folder, `None` while no workspace root is in place, and the
/// place the folder is in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionWorkingFolder {
    /// What the session is bound to.
    pub shape: SessionShape,
    /// The root its shells start in and its file search lists.
    pub working_folder: Option<PathBuf>,
    /// Where the session works: `None` on macOS and Linux, Windows itself or a WSL 2
    /// distribution on Windows, so every git call on the folder runs there.
    pub place: Option<Place>,
    /// The repository the folder belongs to, `None` while no folder is in place or its mount is
    /// no longer attached.
    pub repository: Option<WorkingFolderRepository>,
}

/// The attached repository mount a session's working folder belongs to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkingFolderRepository {
    /// The mount.
    pub repo_mount_id: RepoMountId,
    /// The repository's own checkout, resolved at attach.
    pub repository_root: PathBuf,
    /// Whether the mount is a project's folder, whose repository is fetched; a chat's is not.
    pub is_project: bool,
}

/// Why a session's working folder could not be read.
#[derive(Debug, thiserror::Error)]
pub enum WorkingFolderReadError {
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
pub fn read_working_folder(
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
                repository: match optional_text_column(row, 3, |text| RepoMountId::new(&text))? {
                    Some(repo_mount_id) => Some(WorkingFolderRepository {
                        repo_mount_id,
                        repository_root: PathBuf::from(row.get::<_, String>(4)?),
                        is_project: text_column(row, 5, closed_word::<MountOrigin>)?
                            == MountOrigin::Attached,
                    }),
                    None => None,
                },
            })
        })
        .optional()?
        .ok_or_else(|| session_not_found(session_id).into())
}
