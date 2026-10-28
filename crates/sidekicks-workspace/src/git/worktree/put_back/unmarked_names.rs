//! The names a put-back took before its mark, left by a crash between: an empty folder at the kept
//! copy's original path, and a record in the repository holding only git's `initializing` lock.
//! Git lists neither and its prune never takes a locked record, so the cleanup removes both once
//! no put-back holds them.

use std::io;
use std::path::Path;

use super::INITIALIZING_LOCK;
use crate::git::worktree::reads::RECORD_LOCK_FILE_NAME;
use crate::git::worktree::stale_record::{StaleRecordError, StaleRecordTools, at};
use crate::git::worktree::tree_records::hold_records;

/// Removes the folder at `original_path` while it is empty, and every record in `records_folder`
/// whose one entry is git's `initializing` lock, skipping each name a put-back under way holds or
/// a live tree or a put-back's mark claims. The records are read under the repository's hold, so
/// an add of the daemon's own is never caught between git's writes. Fails with the first read or
/// removal that failed.
pub(crate) async fn remove_unmarked_names(
    tools: StaleRecordTools<'_>,
    original_path: &Path,
    records_folder: &Path,
) -> Result<(), StaleRecordError> {
    if !tools.names_in_use.is_held(original_path)
        && !tools.claims.is_live_tree_at(original_path).await?
    {
        match tokio::fs::remove_dir(original_path).await {
            Ok(()) => {}
            // A folder that holds anything, or none at all, is no name a put-back left.
            Err(failure)
                if matches!(
                    failure.kind(),
                    io::ErrorKind::NotFound
                        | io::ErrorKind::DirectoryNotEmpty
                        | io::ErrorKind::NotADirectory
                ) => {}
            Err(failure) => return Err(at(original_path)(failure)),
        }
    }
    let common_folder = records_folder
        .parent()
        .expect("the records folder sits in its repository's git common folder");
    let _records_hold = match hold_records(common_folder).await {
        Ok(hold) => hold,
        Err(failure) if failure.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(failure) => return Err(at(common_folder)(failure)),
    };
    let mut records = match tokio::fs::read_dir(records_folder).await {
        Ok(records) => records,
        Err(failure) if failure.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(failure) => return Err(at(records_folder)(failure)),
    };
    let restoring = tools.claims.restoring_records().await?;
    while let Some(entry) = records.next_entry().await.map_err(at(records_folder))? {
        let record = entry.path();
        if tools.names_in_use.is_held(&record) || restoring.contains(&record) {
            continue;
        }
        if is_lone_initializing_lock(&record).await? {
            let lock_path = record.join(RECORD_LOCK_FILE_NAME);
            tokio::fs::remove_file(&lock_path)
                .await
                .map_err(at(&lock_path))?;
            tokio::fs::remove_dir(&record).await.map_err(at(&record))?;
        }
    }
    Ok(())
}

// Whether `record` is a folder whose one entry is a lock holding git's `initializing` line.
async fn is_lone_initializing_lock(record: &Path) -> Result<bool, StaleRecordError> {
    let mut entries = match tokio::fs::read_dir(record).await {
        Ok(entries) => entries,
        Err(failure) if failure.kind() == io::ErrorKind::NotADirectory => return Ok(false),
        Err(failure) => return Err(at(record)(failure)),
    };
    let mut names = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(at(record))? {
        names.push(entry.file_name());
    }
    if names != [RECORD_LOCK_FILE_NAME] {
        return Ok(false);
    }
    let lock_path = record.join(RECORD_LOCK_FILE_NAME);
    let lock = tokio::fs::read(&lock_path).await.map_err(at(&lock_path))?;
    Ok(lock.trim_ascii() == INITIALIZING_LOCK.trim_ascii())
}
