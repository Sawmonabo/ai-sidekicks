//! A moved mount's captures carried to its new folder. Each owner's capture folder of a repository
//! is named for the real path of the repository's common git folder, so after a move each owner's
//! folder is renamed to the new path's name and every stored common folder that named the old one
//! is rewritten to the new one.
//!
//! The move's write records the old common folder on the new mount, after the old common folders
//! the ended mount still carried, which it takes forward, so one record, oldest first, is the one
//! pending carry of every move a carry has not yet finished. The capture folders' packing holds
//! the carry pending from the move's write, and from the start for each record a stop left: while
//! it is pending, a capture folder of any of its names opens only once its owner's folder is
//! renamed, so no capture is taken at the newest name beside an old folder. A record or a stored
//! folder that does not read, or a folder that does not resolve, holds only its own mount, which
//! its health tells with the cause and the folder: each opener of a capture folder it names is
//! refused with the cause, and one whose folders resolve at an opener's ask, or at a later move of
//! the mount, is carried then. The carry renames the folders from each old name, then, in one
//! write led by the clear of that record as the carry read it, rewrites the rows, which ends it; a
//! newer move took the record forward when the clear finds it changed, and that move's carry
//! covers the chain. A stop after the move's write keeps the record, and the next start's carry
//! finishes the move: a folder that was already renamed is skipped, and the rows are rewritten.

use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use notify::Watcher;
use rusqlite::{Connection, OptionalExtension, named_params};
use sidekicks_contracts::repo::mount::{RepoMountId, RepoMountState};
use sidekicks_std::missing_entry::MissingEntry as _;
use sidekicks_std::settle_all::{SettleFailures, settle_all};
use sidekicks_store::data_folder::{read_workflow_run_folders, session_storage_root};
use sidekicks_store::database::connection::read_pool::{DatabaseReadError, ReadLength};
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::text_column;
use sidekicks_store::database::writer::WriteError;
use tokio_util::sync::CancellationToken;

use super::RepoMountReattachService;
use crate::git::turn_snapshot::capture_folder::carry::CaptureCarry;
use crate::git::turn_snapshot::capture_folder::{CAPTURES_SEGMENT, real_path_name};
use crate::git::turn_snapshot::capture_steps::joined;
use crate::git::turn_snapshot::kept_index::remove_kept_indexes;
use crate::row_guards::COMMON_DIR_METADATA_PATH;
use crate::trust_envelope::components_equal;

/// Where a moved mount records the common folders its captures are still carried from, as a JSON
/// array, oldest first.
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

// What a log line names the start's carries as.
const START_CARRY_OPERATION: &str = "carrying the moved projects' captures";

// The position of the carry's clear of its record, which refuses once a newer move took it.
const CLEAR_CARRY_STATEMENT: usize = 0;

// The attached mounts whose captures are still to be carried, with the common folders they move
// from and the one they move to, each as its stored JSON, so one that does not read fails only its
// own carry. A later move takes the record forward, so it is always on the attached mount.
static SELECT_UNCARRIED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT id, metadata -> '{CAPTURES_MOVED_FROM_METADATA_PATH}',
        metadata -> '{COMMON_DIR_METADATA_PATH}'
   FROM repo_mounts
  WHERE state = '{}'
    AND json_extract(metadata, '{CAPTURES_MOVED_FROM_METADATA_PATH}') IS NOT NULL
    AND json_extract(metadata, '{COMMON_DIR_METADATA_PATH}') IS NOT NULL
  ORDER BY id",
        <&'static str>::from(RepoMountState::Attached)
    )
});

// The mount's record of its carry as its stored JSON, null once it is cleared or taken forward.
static SELECT_CARRY_RECORD_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT metadata -> '{CAPTURES_MOVED_FROM_METADATA_PATH}'
   FROM repo_mounts
  WHERE id = @repo_mount_id"
    )
});

// Clears the record only while it is the one the carry read: a newer move clears it from the
// ended mount as it takes it forward, so the older carry's write is then refused whole.
static CLEAR_CARRY_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE repo_mounts
    SET metadata = json_remove(metadata, '{CAPTURES_MOVED_FROM_METADATA_PATH}')
  WHERE id = @repo_mount_id AND metadata -> '{CAPTURES_MOVED_FROM_METADATA_PATH}' = @record"
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
    /// The mount's record of its carry did not read as its list of old common folders.
    #[error("a moved mount's record of its carry could not be read")]
    Record(#[source] serde_json::Error),
    /// An owner's folder could not be listed, a common folder resolved or a capture folder
    /// renamed; a capture folder already at the new name is never replaced.
    #[error("a moved mount's capture folder could not be carried")]
    Folder(#[source] io::Error),
    /// The rewritten rows were not kept.
    #[error("a moved mount's rewritten rows were not kept")]
    Write(#[from] WriteError),
}

/// One moved mount whose carry failed, its record kept for the next start.
#[derive(Debug, thiserror::Error)]
#[error("repo mount {repo_mount_id}'s captures were not carried to its new folder")]
pub struct UncarriedMountFailure {
    /// The mount.
    pub repo_mount_id: RepoMountId,
    /// Why.
    #[source]
    pub source: CaptureCarryError,
}

/// The carries of the moved mounts a stop left, held pending by
/// [`expect_moved_captures`](RepoMountReattachService::expect_moved_captures) and run by
/// [`carry_moved_captures`](RepoMountReattachService::carry_moved_captures).
#[derive(Debug)]
pub struct UncarriedCaptures(Vec<(RepoMountId, CaptureCarry)>);

// One attached mount whose captures are still to be carried: its record of the old common
// folders and its newest common folder, each as its stored JSON.
struct UncarriedMount {
    repo_mount_id: RepoMountId,
    moved_from: String,
    moved_to: String,
}

// What a carry reads before it writes: the mount's record as its stored JSON, and each column's
// distinct stored common folders.
struct CarryRead {
    record: String,
    stored: Vec<(CommonFolderColumn, Vec<String>)>,
}

impl<W: Watcher + Send + 'static> RepoMountReattachService<W> {
    /// Holds pending the carry of every moved mount whose carry a stop cut off, so no capture
    /// folder of theirs opens before it is carried, and answers the carries to run. Run at the
    /// start, before anything captures and before the mounts' first health. A record or a stored
    /// folder that does not read, or a folder that does not resolve, is logged and holds only its
    /// own mount, which its health tells, and whose capture folders each opener is refused until an
    /// opener's ask makes its carry. Fails only as the read of the records fails.
    pub async fn expect_moved_captures(&self) -> Result<UncarriedCaptures, CaptureCarryError> {
        let uncarried = self
            .reads
            .read(ReadLength::Short, read_uncarried_mounts)
            .await?;
        let mut carries = Vec::with_capacity(uncarried.len());
        for mount in uncarried {
            let repo_mount_id = mount.repo_mount_id;
            let moved_from = serde_json::from_str::<Vec<PathBuf>>(&mount.moved_from);
            let moved_to = serde_json::from_str::<PathBuf>(&mount.moved_to);
            if let Err(unread) = &moved_to {
                tracing::warn!(
                    %repo_mount_id,
                    error = unread as &(dyn Error + 'static),
                    "a moved project's stored folder could not be read, so its captures are held \
                     until its row is repaired"
                );
            }
            match self
                .packing
                .carries()
                .expect_record(repo_mount_id, moved_from, moved_to)
                .await
            {
                Ok(carry) => carries.push((repo_mount_id, carry)),
                Err(unmade) => tracing::warn!(
                    %repo_mount_id,
                    error = &unmade as &(dyn Error + 'static),
                    "a moved project's captures cannot be carried yet; its capture folders open \
                     for no one until they can"
                ),
            }
        }
        Ok(UncarriedCaptures(carries))
    }

    /// Carries the captures of every moved mount in `uncarried`, as a move carries them. Run at
    /// the start, after [`expect_moved_captures`](Self::expect_moved_captures). Every mount's carry
    /// runs, and the ones that failed are answered together, each keeping its record for the next
    /// start.
    pub async fn carry_moved_captures(
        &self,
        uncarried: UncarriedCaptures,
    ) -> Result<(), SettleFailures<UncarriedMountFailure>> {
        let mut outcomes = Vec::with_capacity(uncarried.0.len());
        for (repo_mount_id, carry) in uncarried.0 {
            outcomes.push(
                self.carry_captures(repo_mount_id, &carry)
                    .await
                    .map_err(|source| UncarriedMountFailure {
                        repo_mount_id,
                        source,
                    }),
            );
        }
        settle_all(outcomes, START_CARRY_OPERATION).map(drop)
    }

    /// Carries, as the start's carry does, each moved mount's captures whose carry an opener's ask
    /// made in this run, until `stop` fires; a carry made before `stop` fired is run first. Then
    /// probes the mount's health again, so the hold it told ends. Logs each one that failed, which
    /// keeps its record for the next start; a mount moved again since finds its record gone, and
    /// that move's chain carries it.
    pub async fn carry_lifted_captures(&self, stop: &CancellationToken) {
        loop {
            let lifted = tokio::select! {
                biased;
                lifted = self.packing.carries().next_lifted() => lifted,
                () = stop.cancelled() => return,
            };
            for (repo_mount_id, carry) in lifted {
                if let Err(error) = self.carry_captures(repo_mount_id, &carry).await {
                    tracing::warn!(
                        %repo_mount_id,
                        error = &error as &(dyn Error + 'static),
                        "a moved project's captures could not be carried to its new folder; its \
                         next start tries again"
                    );
                }
                if let Err(error) = self.health.reprobe_mount(repo_mount_id).await {
                    tracing::warn!(
                        %repo_mount_id,
                        error = &error as &(dyn Error + 'static),
                        "a moved project's health could not be probed once its captures were \
                         carried; its next pass tells it"
                    );
                }
            }
        }
    }

    /// Renames each owner's capture folder of the moved repository `carry` names from each of its
    /// old names, oldest first, or, for a carry that renames nothing, removes each one's kept
    /// indexes, then, in one write, clears the mount's record of the carry as it was read and
    /// rewrites every stored common folder that names an old one, which ends it. A record already
    /// gone, or changed by the write's time, was taken forward by a newer move, whose carry covers
    /// this one: nothing is written and the carry stays pending. Fails as the listing, a rename, a
    /// read or the write fails, the record and the pending carry then kept.
    pub(super) async fn carry_captures(
        &self,
        repo_mount_id: RepoMountId,
        carry: &CaptureCarry,
    ) -> Result<(), CaptureCarryError> {
        let columns = self.common_folder_columns.clone();
        let read = self
            .reads
            .read(ReadLength::Short, move |connection| {
                read_carry(connection, repo_mount_id, &columns)
            })
            .await?;
        let Some(CarryRead { record, stored }) = read else {
            return Ok(());
        };
        let moved_from: Vec<PathBuf> =
            serde_json::from_str(&record).map_err(CaptureCarryError::Record)?;

        let (old_names, new_name) = (carry.old_names(), carry.new_name());
        let data_folder = self.data_folder.clone();
        let owners = joined(tokio::task::spawn_blocking(move || owner_folders(&data_folder)).await)
            .map_err(CaptureCarryError::Folder)?;
        for owner in owners {
            let captures = owner.join(CAPTURES_SEGMENT);
            if carry.is_rename() {
                // Oldest first: a carry of an earlier move still running renames to the next name.
                for old_name in old_names {
                    self.packing
                        .move_capture_folder(&captures.join(old_name), &captures.join(new_name))
                        .await
                        .map_err(CaptureCarryError::Folder)?;
                }
            } else {
                // The folder keeps its name; its kept indexes go, the moved checkout's among them.
                let folder = captures.join(new_name);
                let _hold = self.packing.hold_capture_folder(&folder).await;
                joined(tokio::task::spawn_blocking(move || remove_kept_indexes(&folder)).await)
                    .map_err(CaptureCarryError::Folder)?;
            }
        }

        let moved_to = carry.moved_to().to_string_lossy();
        let mut statements = vec![WriteStatement {
            sql: CLEAR_CARRY_SQL.as_str().into(),
            bindings: StatementBindings::Named(vec![
                text_binding("@repo_mount_id", repo_mount_id.text().as_str()),
                text_binding("@record", &record),
            ]),
            expected_row_count: Some(1),
        }];
        for (column, spellings) in stored {
            let mut moved = Vec::new();
            for spelling in spellings {
                if names_old_folder(&spelling, &moved_from, carry).await {
                    moved.push(spelling);
                }
            }
            if !moved.is_empty() {
                statements.push(rewrite_statement(column, &moved, &moved_to));
            }
        }
        #[cfg(test)]
        self.carry_write_pause.pass().await;
        match self.writer.write(statements).await {
            Ok(_written) => {
                self.packing.carries().finish(carry);
                Ok(())
            }
            Err(refused) if refused.refused_statement_index() == Some(CLEAR_CARRY_STATEMENT) => {
                Ok(())
            }
            Err(failed) => Err(failed.into()),
        }
    }
}

// Whether the stored common folder `spelling` names one of `carry`'s old folders: by the record's
// own spelling `moved_from` first, else by its real path's name. A spelling that does not resolve
// is another repository's folder the daemon cannot reach, so it is passed over with a log line.
async fn names_old_folder(spelling: &str, moved_from: &[PathBuf], carry: &CaptureCarry) -> bool {
    let folder = Path::new(spelling);
    if moved_from.iter().any(|old| components_equal(folder, old)) {
        return true;
    }
    if components_equal(folder, carry.moved_to()) {
        return false;
    }
    match real_path_name(folder).await {
        Ok(name) => carry.old_names().contains(&name),
        Err(unresolved) => {
            tracing::warn!(
                folder = %spelling,
                error = &unresolved as &(dyn Error + 'static),
                "a stored common folder could not be resolved, so a moved project's carry passes \
                 it over"
            );
            false
        }
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
                moved_from: row.get(1)?,
                moved_to: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

// The mount's record and the stored common folders, or `None` once its record is gone.
fn read_carry(
    connection: &Connection,
    repo_mount_id: RepoMountId,
    columns: &[CommonFolderColumn],
) -> Result<Option<CarryRead>, CaptureCarryError> {
    let record: Option<String> = connection
        .prepare_cached(&SELECT_CARRY_RECORD_SQL)?
        .query_row(
            named_params! { "@repo_mount_id": repo_mount_id.text().as_str() },
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    let Some(record) = record else {
        return Ok(None);
    };
    Ok(Some(CarryRead {
        record,
        stored: read_stored_common_folders(connection, columns)?,
    }))
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
