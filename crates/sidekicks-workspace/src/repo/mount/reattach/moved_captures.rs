//! A moved mount's captures carried to its new folder. Each owner's capture folder of a repository
//! is named for the real path of the repository's common git folder, so after a move each owner's
//! folder is renamed to the new path's name and every stored common folder that named the old one
//! is rewritten to the new one.
//!
//! The move's write records the old common folder on the new mount. The carry renames the folders,
//! then rewrites the rows and clears that record in one write. A stop after the move's write keeps
//! the record, and the next start's carry finishes the move: a folder that was already renamed is
//! skipped, and the rows are rewritten.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use notify::Watcher;
use rusqlite::Connection;
use sidekicks_contracts::repo::mount::{RepoMountId, RepoMountState};
use sidekicks_std::missing_entry::MissingEntry as _;
use sidekicks_store::data_folder::{read_workflow_run_folders, session_storage_root};
use sidekicks_store::database::connection::read_pool::{DatabaseReadError, ReadLength};
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::text_column;
use sidekicks_store::database::writer::WriteError;

use super::RepoMountReattachService;
use crate::git::turn_snapshot::capture_folder::{CAPTURES_SEGMENT, real_path_name};
use crate::git::turn_snapshot::capture_steps::joined;
use crate::row_guards::COMMON_DIR_METADATA_PATH;

/// Where a moved mount records the common folder its captures are still carried from.
pub(super) const CAPTURES_MOVED_FROM_METADATA_PATH: &str = "$.capturesMovedFrom";

/// A stored column holding the common git folder of the repository a capture was taken from,
/// which a move rewrites to the folder's new path.
#[derive(Clone, Copy, Debug)]
pub struct CommonFolderColumn {
    /// The table.
    pub table: &'static str,
    /// The column.
    pub column: &'static str,
}

/// The run contexts' common folder, which a run's captures are found by.
pub const RUN_CONTEXT_COMMON_FOLDER: CommonFolderColumn = CommonFolderColumn {
    table: "run_execution_contexts",
    column: "git_common_dir",
};

// The attached mounts whose captures are still to be carried, with the common folder they move
// from and the one they move to.
static SELECT_UNCARRIED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT id, json_extract(metadata, '{CAPTURES_MOVED_FROM_METADATA_PATH}'),
        json_extract(metadata, '{COMMON_DIR_METADATA_PATH}')
   FROM repo_mounts
  WHERE state = '{}'
    AND json_extract(metadata, '{CAPTURES_MOVED_FROM_METADATA_PATH}') IS NOT NULL
    AND json_extract(metadata, '{COMMON_DIR_METADATA_PATH}') IS NOT NULL
  ORDER BY id",
        <&'static str>::from(RepoMountState::Attached)
    )
});

static CLEAR_CARRY_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE repo_mounts
    SET metadata = json_remove(metadata, '{CAPTURES_MOVED_FROM_METADATA_PATH}')
  WHERE id = @repo_mount_id"
    )
});

/// Why a moved mount's captures were not carried; what was renamed stays renamed, and the next
/// start's carry finishes the rest.
#[derive(Debug, thiserror::Error)]
pub enum CaptureCarryError {
    /// A read did not reach the database.
    #[error("the moved mounts' rows did not reach the database")]
    Read(#[from] DatabaseReadError),
    /// A stored row did not read as its type.
    #[error("a moved mount's row could not be read")]
    Row(#[from] rusqlite::Error),
    /// An owner's folder could not be listed, a common folder resolved or a capture folder
    /// renamed; a capture folder already at the new name is never replaced.
    #[error("a moved mount's capture folder could not be carried")]
    Folder(#[source] io::Error),
    /// The rewritten rows were not kept.
    #[error("a moved mount's rewritten rows were not kept")]
    Write(#[from] WriteError),
}

// One attached mount whose captures are still to be carried.
struct UncarriedMount {
    repo_mount_id: RepoMountId,
    moved_from: PathBuf,
    moved_to: PathBuf,
}

impl<W: Watcher + Send + 'static> RepoMountReattachService<W> {
    /// Carries the captures of every moved mount whose carry a stop cut off, as a move carries
    /// them. Run at the start. Fails at the first mount whose carry failed; that mount, and each
    /// one after it, keeps its record for the next start.
    pub async fn carry_moved_captures(&self) -> Result<(), CaptureCarryError> {
        let uncarried = self
            .reads
            .read(ReadLength::Short, read_uncarried_mounts)
            .await?;
        for mount in uncarried {
            self.carry_captures(mount.repo_mount_id, &mount.moved_from, &mount.moved_to)
                .await?;
        }
        Ok(())
    }

    /// Renames each owner's capture folder of the repository whose common folder moved from
    /// `moved_from` to `moved_to`, then, in one write, rewrites every stored common folder named
    /// like `moved_from` and clears the mount's record of the carry. Fails as the listing, a
    /// rename, a read or the write fails, the record then kept.
    pub(super) async fn carry_captures(
        &self,
        repo_mount_id: RepoMountId,
        moved_from: &Path,
        moved_to: &Path,
    ) -> Result<(), CaptureCarryError> {
        let from_name = real_path_name(moved_from)
            .await
            .map_err(CaptureCarryError::Folder)?;
        let to_name = real_path_name(moved_to)
            .await
            .map_err(CaptureCarryError::Folder)?;
        let data_folder = self.data_folder.clone();
        let owners = joined(tokio::task::spawn_blocking(move || owner_folders(&data_folder)).await)
            .map_err(CaptureCarryError::Folder)?;
        for owner in owners {
            let captures = owner.join(CAPTURES_SEGMENT);
            self.packing
                .move_capture_folder(&captures.join(&from_name), &captures.join(&to_name))
                .await
                .map_err(CaptureCarryError::Folder)?;
        }

        let columns = self.common_folder_columns.clone();
        let stored = self
            .reads
            .read(ReadLength::Short, move |connection| {
                read_stored_common_folders(connection, &columns)
            })
            .await?;
        let moved_to = moved_to.to_string_lossy();
        let mut statements = Vec::new();
        for (column, spellings) in stored {
            let mut moved = Vec::new();
            for spelling in spellings {
                let name = real_path_name(Path::new(&spelling))
                    .await
                    .map_err(CaptureCarryError::Folder)?;
                if name == from_name {
                    moved.push(spelling);
                }
            }
            if !moved.is_empty() {
                statements.push(rewrite_statement(column, &moved, &moved_to));
            }
        }
        statements.push(WriteStatement {
            sql: CLEAR_CARRY_SQL.as_str().into(),
            bindings: StatementBindings::Named(vec![text_binding(
                "@repo_mount_id",
                repo_mount_id.text().as_str(),
            )]),
            expected_row_count: None,
        });
        self.writer.write(statements).await?;
        Ok(())
    }
}

// Every owner's folder in the data folder: each session's storage folder and each workflow run's
// folder. Blocking.
fn owner_folders(data_folder: &Path) -> io::Result<Vec<PathBuf>> {
    let mut owners = Vec::new();
    if let Some(entries) = std::fs::read_dir(session_storage_root(data_folder)).none_if_missing()? {
        for entry in entries {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                owners.push(entry.path());
            }
        }
    }
    owners.extend(
        read_workflow_run_folders(data_folder)?
            .into_iter()
            .map(|run| run.folder),
    );
    Ok(owners)
}

fn read_uncarried_mounts(
    connection: &Connection,
) -> Result<Vec<UncarriedMount>, CaptureCarryError> {
    Ok(connection
        .prepare_cached(&SELECT_UNCARRIED_SQL)?
        .query_map([], |row| {
            Ok(UncarriedMount {
                repo_mount_id: text_column(row, 0, |text| RepoMountId::new(&text))?,
                moved_from: PathBuf::from(row.get::<_, String>(1)?),
                moved_to: PathBuf::from(row.get::<_, String>(2)?),
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

// Each column's distinct stored common folders.
fn read_stored_common_folders(
    connection: &Connection,
    columns: &[CommonFolderColumn],
) -> Result<Vec<(CommonFolderColumn, Vec<String>)>, CaptureCarryError> {
    let mut stored = Vec::with_capacity(columns.len());
    for column in columns {
        let CommonFolderColumn {
            table,
            column: name,
        } = *column;
        let spellings = connection
            .prepare_cached(&format!(
                "SELECT DISTINCT {name} FROM {table} WHERE {name} IS NOT NULL"
            ))?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<_>>()?;
        stored.push((*column, spellings));
    }
    Ok(stored)
}

// Rewrites `column` from each of `moved` to `moved_to`.
fn rewrite_statement(
    column: CommonFolderColumn,
    moved: &[String],
    moved_to: &str,
) -> WriteStatement {
    let CommonFolderColumn {
        table,
        column: name,
    } = column;
    WriteStatement {
        sql: format!(
            "UPDATE {table} SET {name} = @moved_to
  WHERE {name} IN (SELECT value FROM json_each(@moved))"
        )
        .into(),
        bindings: StatementBindings::Named(vec![
            text_binding("@moved_to", moved_to),
            text_binding(
                "@moved",
                &serde_json::Value::from(moved.to_vec()).to_string(),
            ),
        ]),
        expected_row_count: None,
    }
}
