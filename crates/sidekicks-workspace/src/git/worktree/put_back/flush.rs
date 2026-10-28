//! Flushing everything a put-back wrote, so the tree it records survives a power loss: the new
//! branch first, while the rest is listed, then the tree's `.git` file, the record, the restored
//! objects and, after a copy, the tree, each with the folders that name it.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use ignore::WalkBuilder;
use sidekicks_platforms::{flush_file, flush_folder};
use sidekicks_std::missing_entry::MissingEntry;
use sidekicks_std::settle_all::{SettleFailures, settle_all};
use tokio::task::JoinError;

use super::objects::RestoredObjects;
use super::record::TakenRecord;
use crate::git::worktree::flush::{DiskFlushError, flush_to_disk};
use crate::git::worktree::kept_copy::folder_move::FolderPlacement;
use crate::git::worktree::reads::{BRANCH_REF_PREFIX, GIT_FILE_NAME};

// A reftable repository keeps every ref in the tables under this folder, which no other ref store
// makes; the list names the tables in order.
const REFTABLE_FOLDER_NAME: &str = "reftable";
const TABLE_LIST_FILE_NAME: &str = "tables.list";
// The list changes between a pass's read and its check only when a ref write lands in that window,
// rare even twice.
const REF_TABLE_PASS_LIMIT: u32 = 3;
const PACKED_REFS_FILE_NAME: &str = "packed-refs";
const REFLOG_FOLDER_NAME: &str = "logs";
const REFS_FOLDER_NAME: &str = "refs";

/// One flush of what a put-back wrote that failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum PutBackFlushError {
    /// The flush of files and folders failed.
    #[error(transparent)]
    Disk(#[from] SettleFailures<DiskFlushError>),
    /// A file or folder could not be read or flushed.
    #[error("{} could not be read or flushed", path.display())]
    File {
        /// The entry.
        path: PathBuf,
        /// The failure.
        #[source]
        source: io::Error,
    },
    /// A folder written could not be listed.
    #[error("{} could not be listed to flush it", folder.display())]
    List {
        /// The folder.
        folder: PathBuf,
        /// The walk's failure.
        #[source]
        source: ignore::Error,
    },
    /// The ref tables kept changing while they were flushed.
    #[error("the ref tables in {} kept changing while they were flushed", folder.display())]
    TablesChanging {
        /// The reftable folder.
        folder: PathBuf,
    },
    /// A blocking task ended before it finished.
    #[error("a put-back's flush ended before it finished")]
    Interrupted(#[source] JoinError),
}

fn at(path: &Path) -> impl FnOnce(io::Error) -> PutBackFlushError {
    let path = path.to_path_buf();
    move |source| PutBackFlushError::File { path, source }
}

/// What a put-back wrote, which it flushes before the caller records the tree.
pub(super) struct PutBackWrites<'a> {
    /// The folder the tree went to.
    pub(super) target_folder: &'a Path,
    /// The record the put-back took.
    pub(super) record: &'a TakenRecord,
    /// Whether the tree was renamed or copied into its folder.
    pub(super) placement: FolderPlacement,
    /// The objects copied into the repository.
    pub(super) restored: &'a RestoredObjects,
    /// The repository's git common folder.
    pub(super) common_folder: &'a Path,
    /// The branch the put-back made, if any.
    pub(super) new_branch: Option<&'a str>,
}

/// Flushes everything `writes` names, each file and the folder that names it. Fails with every
/// flush's failure once all have settled.
pub(super) async fn flush_put_back_writes(
    writes: PutBackWrites<'_>,
) -> Result<(), SettleFailures<PutBackFlushError>> {
    // The branch is flushed while the rest is listed, so a ref write elsewhere in the repository
    // has the least time to move it.
    let (record, copied_tree, ()) = settle_all(
        tokio::join!(
            list_folder_entries(&writes.record.record_folder),
            async {
                match writes.placement {
                    FolderPlacement::Copied => list_folder_entries(writes.target_folder).await,
                    FolderPlacement::Renamed => Ok(FolderEntries::default()),
                }
            },
            async {
                match writes.new_branch {
                    Some(branch) => flush_new_branch(writes.common_folder, branch).await,
                    None => Ok(()),
                }
            },
        ),
        "flushing the put-back",
    )?;
    let restored = writes.restored;
    let files = [writes.target_folder.join(GIT_FILE_NAME)]
        .into_iter()
        .chain(record.files)
        .chain(copied_tree.files)
        .chain(restored.files.iter().cloned());
    // A folder names what it holds: each restored object's folder and each folder made for one.
    let object_folders = restored
        .files
        .iter()
        .chain(&restored.made_folders)
        .filter_map(|path| path.parent().map(Path::to_path_buf))
        .collect::<Vec<_>>();
    let folders = [
        writes.target_folder.parent().map(Path::to_path_buf),
        Some(writes.target_folder.to_path_buf()),
        writes.record.record_folder.parent().map(Path::to_path_buf),
        writes
            .record
            .is_records_folder_made
            .then(|| writes.common_folder.to_path_buf()),
    ]
    .into_iter()
    .flatten()
    .chain(record.folders)
    .chain(copied_tree.folders)
    .chain(object_folders);
    flush_to_disk(files, folders)
        .await
        .map_err(|failure| SettleFailures::One(PutBackFlushError::Disk(failure)))
}

// The files and folders a flush reaches.
#[derive(Debug, Default)]
struct FolderEntries {
    files: Vec<PathBuf>,
    folders: Vec<PathBuf>,
}

// `folder` and every file and folder under it; a link or any other entry is left out.
async fn list_folder_entries(folder: &Path) -> Result<FolderEntries, PutBackFlushError> {
    let folder = folder.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut entries = FolderEntries::default();
        let walk = WalkBuilder::new(&folder)
            .standard_filters(false)
            .follow_links(false)
            .build();
        for entry in walk {
            let entry = entry.map_err(|source| PutBackFlushError::List {
                folder: folder.clone(),
                source,
            })?;
            match entry.file_type() {
                Some(kind) if kind.is_file() => entries.files.push(entry.into_path()),
                Some(kind) if kind.is_dir() => entries.folders.push(entry.into_path()),
                Some(_) | None => {}
            }
        }
        Ok(entries)
    })
    .await
    .map_err(PutBackFlushError::Interrupted)?
}

// Flushes where git wrote the new branch: the ref tables of a reftable repository, else the
// branch's own ref file.
async fn flush_new_branch(common_folder: &Path, branch: &str) -> Result<(), PutBackFlushError> {
    let (common_folder, branch) = (common_folder.to_path_buf(), branch.to_owned());
    tokio::task::spawn_blocking(move || {
        let reftable_folder = common_folder.join(REFTABLE_FOLDER_NAME);
        if reftable_folder.try_exists().map_err(at(&reftable_folder))? {
            flush_ref_tables(&reftable_folder)
        } else {
            flush_loose_branch_ref(&common_folder, &branch)
        }
    })
    .await
    .map_err(PutBackFlushError::Interrupted)?
}

// Flushes each table the list names, then the list, then reads the list again. A ref write
// elsewhere can compact the tables meanwhile into a new table that holds the branch, so a pass
// repeats while the list names a table not yet flushed, and the folder is flushed last.
fn flush_ref_tables(reftable_folder: &Path) -> Result<(), PutBackFlushError> {
    let table_list = reftable_folder.join(TABLE_LIST_FILE_NAME);
    let read_table_list = || -> Result<Vec<String>, PutBackFlushError> {
        Ok(fs::read_to_string(&table_list)
            .map_err(at(&table_list))?
            .lines()
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .collect())
    };
    let mut flushed_tables = Vec::new();
    let mut tables = read_table_list()?;
    for _ in 0..REF_TABLE_PASS_LIMIT {
        let unflushed_tables = tables
            .iter()
            .filter(|table| !flushed_tables.contains(*table))
            .cloned()
            .collect::<Vec<_>>();
        for table in unflushed_tables {
            // A table compacted away mid-flush is gone, and the list read after this pass no
            // longer names it.
            if flush_unless_gone(&reftable_folder.join(&table))? {
                flushed_tables.push(table);
            }
        }
        flush_file(&table_list).map_err(at(&table_list))?;
        tables = read_table_list()?;
        if tables.iter().all(|table| flushed_tables.contains(table)) {
            return flush_folder(reftable_folder).map_err(at(reftable_folder));
        }
    }
    Err(PutBackFlushError::TablesChanging {
        folder: reftable_folder.to_path_buf(),
    })
}

// Flushes the branch's ref file and, when git keeps one, its reflog, each with its folders. A ref
// file gone, before its flush or after it, was packed into `packed-refs` since git wrote it (`git
// gc --auto` packs refs), so that file and the folder that names it are flushed as well.
fn flush_loose_branch_ref(common_folder: &Path, branch: &str) -> Result<(), PutBackFlushError> {
    let branch_ref = format!("{BRANCH_REF_PREFIX}{branch}");
    let ref_file = common_folder.join(&branch_ref);
    let reflog_file = common_folder.join(REFLOG_FOLDER_NAME).join(&branch_ref);
    let refs_folder = common_folder.join(REFS_FOLDER_NAME);
    let is_ref_flushed = flush_unless_gone(&ref_file)?;
    let mut folders = Vec::new();
    if is_ref_flushed {
        folders.extend(folders_below(&ref_file, &refs_folder));
    }
    if flush_unless_gone(&reflog_file)? {
        folders.extend(folders_below(&reflog_file, common_folder));
    }
    for folder in folders {
        flush_folder(folder).map_err(at(folder))?;
    }
    if !is_ref_flushed || !ref_file.try_exists().map_err(at(&ref_file))? {
        let packed_refs = common_folder.join(PACKED_REFS_FILE_NAME);
        flush_file(&packed_refs).map_err(at(&packed_refs))?;
        flush_folder(common_folder).map_err(at(common_folder))?;
    }
    Ok(())
}

// Flushes the file at `path`, answering `false` when it is gone.
fn flush_unless_gone(path: &Path) -> Result<bool, PutBackFlushError> {
    Ok(flush_file(path)
        .none_if_missing()
        .map_err(at(path))?
        .is_some())
}

// The folders that hold `path`, from its own up to, not including, `top`.
fn folders_below<'a>(path: &'a Path, top: &'a Path) -> impl Iterator<Item = &'a Path> {
    path.ancestors()
        .skip(1)
        .take_while(move |folder| *folder != top && folder.starts_with(top))
}
