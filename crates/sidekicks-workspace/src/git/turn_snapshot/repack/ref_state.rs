//! The stat data that tells a sweep whether any ref of a repository moved since its last pass,
//! without running git: every ref, `packed-refs` and `reftable/tables.list` write is a lock file
//! made beside its target and renamed over it, which changes the target's own facts and its
//! folder's times. Both ref formats' files are read, so no setting is read to tell them apart.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sidekicks_platforms::{FileFacts, file_facts};
use sidekicks_std::file::time_precision::COARSEST_TIME_PRECISION;

/// The facts of every ref file and ref folder of one repository that exists, by path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct RefState {
    /// Each path read, with its facts.
    entries: BTreeMap<PathBuf, FileFacts>,
}

impl RefState {
    /// Whether any entry was modified or changed within the coarsest time precision of `read_at`,
    /// or after it, so a write right after the read could keep the facts it had.
    pub(super) fn has_entry_near(&self, read_at: SystemTime) -> bool {
        has_entry_near(&self.entries, read_at)
    }
}

/// Whether any of `entries` was modified or changed within the coarsest time precision of
/// `read_at`, or after it, so a write right after the read could keep the facts it had.
pub(super) fn has_entry_near(entries: &BTreeMap<PathBuf, FileFacts>, read_at: SystemTime) -> bool {
    let Some(read_at) = nanoseconds_since_epoch(read_at) else {
        return true;
    };
    let window = i128::try_from(COARSEST_TIME_PRECISION.as_nanos()).unwrap_or(i128::MAX);
    let earliest_safe = read_at.saturating_sub(window);
    entries
        .values()
        .any(|facts| facts.modified >= earliest_safe || facts.changed >= earliest_safe)
}

/// The ref state of the repository whose common git folder is `common`: its `HEAD`,
/// `packed-refs` and `reftable/tables.list`, its `refs` folder and every folder under it, its
/// `worktrees` folder, and for each linked worktree its `HEAD`, `reftable/tables.list`, `refs`
/// folder and every folder under that. A path that does not exist is left out. Blocking. Fails as
/// a stat or a folder listing does, a missing path aside.
pub(super) fn read_ref_state(common: &Path) -> io::Result<RefState> {
    let mut entries = BTreeMap::new();
    read_ref_files(common, &mut entries)?;
    let worktrees = common.join("worktrees");
    read_entry(&worktrees, &mut entries)?;
    for worktree in child_folders(&worktrees)? {
        read_ref_files(&worktree, &mut entries)?;
    }
    Ok(RefState { entries })
}

// The ref files and folders one git folder holds, the main one or a linked worktree's.
fn read_ref_files(git_folder: &Path, entries: &mut BTreeMap<PathBuf, FileFacts>) -> io::Result<()> {
    for file in ["HEAD", "packed-refs"] {
        read_entry(&git_folder.join(file), entries)?;
    }
    read_entry(&git_folder.join("reftable").join("tables.list"), entries)?;
    let mut pending = vec![git_folder.join("refs")];
    while let Some(folder) = pending.pop() {
        if read_entry(&folder, entries)? {
            pending.extend(child_folders(&folder)?);
        }
    }
    Ok(())
}

/// Adds `path`'s facts to `entries`, answering whether it exists. Fails as the stat does, a
/// missing path aside.
pub(super) fn read_entry(
    path: &Path,
    entries: &mut BTreeMap<PathBuf, FileFacts>,
) -> io::Result<bool> {
    match file_facts(path) {
        Ok(facts) => {
            entries.insert(path.to_path_buf(), facts);
            Ok(true)
        }
        Err(missing) if missing.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(failure) => Err(failure),
    }
}

/// The folders directly in `folder`, never through a link; none when `folder` does not exist.
/// Fails as the listing does.
pub(super) fn child_folders(folder: &Path) -> io::Result<Vec<PathBuf>> {
    let listing = match fs::read_dir(folder) {
        Ok(listing) => listing,
        Err(missing) if missing.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(failure) => return Err(failure),
    };
    let mut folders = Vec::new();
    for entry in listing {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            folders.push(entry.path());
        }
    }
    Ok(folders)
}

// `instant` in nanoseconds since the Unix epoch, as the facts keep their times; `None` before the
// epoch or past what the count holds.
fn nanoseconds_since_epoch(instant: SystemTime) -> Option<i128> {
    instant
        .duration_since(UNIX_EPOCH)
        .ok()
        .as_ref()
        .map(Duration::as_nanos)
        .and_then(|nanoseconds| i128::try_from(nanoseconds).ok())
}

#[cfg(test)]
mod tests;
