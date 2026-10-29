//! The copy of a chat's workspace into the repository's working tree. Each file is written under a
//! name of the daemon's own beside its target and published under its real name once whole, never
//! replacing a file the repository holds, so a stop part way never leaves half a file under a name
//! the repository's files use. No link is followed on either side: a link or a special file in the
//! workspace is named and left, and a folder of the repository that is a link or a file takes
//! nothing. Each file's outcome is recorded as it lands, while the copy goes on.

use std::borrow::Cow;
use std::collections::{BTreeSet, HashSet};
use std::ffi::OsStr;
use std::fs::{self, Permissions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::types::Value;
use sidekicks_contracts::session::convert::SessionConvertSkipReason;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::{
    RegularFileOpen, create_new_file, open_regular_file, os_text_stable_bytes,
};
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::file::publish_without_replacing::{PublishOutcome, publish_without_replacing};
use sidekicks_std::missing_entry::is_gone;
use sidekicks_store::database::schema::session_directory::ConvertedFileOutcome;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};
use tokio::task::{JoinError, JoinSet};

use crate::convert::SessionConversionError;

// The workspace's own repository is the daemon's record of the chat, never one of its files.
const GIT_METADATA_ENTRY_NAME: &str = ".git";

// A file is written under this name, the session's id after it, in the folder it lands in, and
// published under its own name once whole. Nothing but the session's conversion makes a file so
// named.
const COPY_IN_PROGRESS_NAME_PREFIX: &str = ".ai-sidekicks-copy-";

// The mode a copy is written with, before its file takes the source's own.
const COPY_MODE: u32 = 0o600;

// The most file records waiting on their commit while the copy goes on: enough to keep the
// writer's batches full, and the most landed copies a crash can leave unrecorded.
const RECORDS_IN_FLIGHT_MAX: usize = 100;

const RECORD_FILE_SQL: &str = "INSERT INTO session_convert_files
  (session_id, path_key, path, outcome) VALUES (@session_id, @path_key, @path, @outcome)";

const COPYING: &str = "copying a chat's file into the repository";

/// The folders one conversion copies between, and the session whose copies they hold.
pub(super) struct ConversionFolders {
    /// The session.
    pub(super) session_id: SessionId,
    /// The chat's managed workspace.
    pub(super) workspace_root: PathBuf,
    /// The repository's working tree the files go into.
    pub(super) working_tree: PathBuf,
}

/// One of the workspace's files: its path under the workspace, that path as its record keys it
/// (each name's stable bytes, joined by the stable bytes of `/`, which no name holds), and as it
/// is shown, `/`-separated with a name that is not Unicode written lossily.
struct WorkspaceEntry {
    relative: PathBuf,
    key: Vec<u8>,
    shown: String,
}

/// What one workspace entry came to: copied, left out for a reason, or gone since the listing.
enum EntryOutcome {
    Copied,
    Skipped(SessionConvertSkipReason),
    Gone,
}

/// What writing one entry's copy beside its target came to.
enum WrittenCopy {
    /// The copy is whole at `copy_path`, to be published at `target` and given `permissions`.
    Written {
        copy_path: PathBuf,
        target: PathBuf,
        permissions: Permissions,
    },
    Skipped(SessionConvertSkipReason),
    Gone,
}

/// Copies each workspace file the conversion has not yet dealt with into the working tree, in name
/// order, once the copy a stop part way left is removed, and records each outcome through `writer`
/// as it lands. At most [`RECORDS_IN_FLIGHT_MAX`] records wait at once, and every one has settled
/// before this answers, so each landed copy is counted. A failed copy or record stops the copy and
/// is answered.
pub(super) async fn copy_workspace_files(
    folders: &ConversionFolders,
    dealt_with: &HashSet<Vec<u8>>,
    writer: &Arc<DatabaseWriter>,
) -> Result<(), SessionConversionError> {
    let pending = list_pending_entries(folders, dealt_with).await?;
    remove_copies_beside(folders, &pending).await?;
    let mut records = JoinSet::new();
    let mut record_failure = None;
    let mut copy_failure = None;
    for entry in &pending {
        let outcome = match copy_entry(folders, entry).await {
            Ok(outcome) => outcome,
            Err(failure) => {
                copy_failure = Some(failure);
                break;
            }
        };
        let recorded: &'static str = match outcome {
            EntryOutcome::Copied => ConvertedFileOutcome::Copied.into(),
            EntryOutcome::Skipped(reason) => reason.into(),
            EntryOutcome::Gone => continue,
        };
        let statement = record_file_statement(folders.session_id, entry, recorded);
        let writer = Arc::clone(writer);
        records.spawn(async move { writer.write(vec![statement]).await.map(drop) });
        if records.len() >= RECORDS_IN_FLIGHT_MAX
            && let Some(landed) = records.join_next().await
        {
            note_record(landed, &mut record_failure);
            if record_failure.is_some() {
                break;
            }
        }
    }
    while let Some(landed) = records.join_next().await {
        note_record(landed, &mut record_failure);
    }
    match (copy_failure, record_failure) {
        (Some(failure), _) | (None, Some(failure)) => Err(failure),
        (None, None) => Ok(()),
    }
}

/// Removes the copy a conversion that stopped part way was writing under the daemon's name. Its
/// copy never got a record, so it sits in the folder of one of the files not yet dealt with.
pub(super) async fn remove_stopped_copy(
    folders: &ConversionFolders,
    dealt_with: &HashSet<Vec<u8>>,
) -> Result<(), SessionConversionError> {
    let pending = list_pending_entries(folders, dealt_with).await?;
    remove_copies_beside(folders, &pending).await
}

// Keeps a record's failure, the first one only: a failing writer fails every write after with the
// same reason.
fn note_record(
    landed: Result<Result<(), WriteError>, JoinError>,
    record_failure: &mut Option<SessionConversionError>,
) {
    let failure = match landed {
        Ok(Ok(())) => return,
        Ok(Err(write)) => SessionConversionError::Write(write),
        Err(join) => SessionConversionError::File(io::Error::other(join)),
    };
    record_failure.get_or_insert(failure);
}

// The workspace's files the conversion has yet to deal with, in name order.
async fn list_pending_entries(
    folders: &ConversionFolders,
    dealt_with: &HashSet<Vec<u8>>,
) -> Result<Vec<WorkspaceEntry>, SessionConversionError> {
    let workspace_root = folders.workspace_root.clone();
    let working_tree = folders.working_tree.clone();
    let mut entries = on_blocking_thread(move || {
        list_workspace_entries(&workspace_root, &working_tree).map_err(SessionConversionError::File)
    })
    .await?;
    entries.retain(|entry| !dealt_with.contains(&entry.key));
    Ok(entries)
}

async fn remove_copies_beside(
    folders: &ConversionFolders,
    pending: &[WorkspaceEntry],
) -> Result<(), SessionConversionError> {
    let copy_name = copy_name_of(folders.session_id);
    let copy_paths: BTreeSet<PathBuf> = pending
        .iter()
        .map(|entry| {
            let folder = entry.relative.parent().unwrap_or(Path::new(""));
            folders.working_tree.join(folder).join(&copy_name)
        })
        .collect();
    on_blocking_thread(move || {
        for copy_path in copy_paths {
            match fs::remove_file(&copy_path) {
                Ok(()) => {}
                // Nothing was left there, or the repository holds no folder there to have held it.
                Err(error) if is_gone(&error) => {}
                Err(error) => return Err(SessionConversionError::File(error)),
            }
        }
        Ok(())
    })
    .await
}

// Every entry of the workspace but its folders, in key order: files, links and special files
// alike, each left to the copy to tell apart on the opened entry. The walk never descends through
// a link, so nothing outside the workspace is listed, and it leaves out the workspace's own
// repository at its root and the working tree when that sits inside the workspace, so the
// repository is never copied into itself. A folder removed while the walk runs holds nothing.
fn list_workspace_entries(
    workspace_root: &Path,
    working_tree: &Path,
) -> io::Result<Vec<WorkspaceEntry>> {
    let mut entries = Vec::new();
    let mut folders = vec![(PathBuf::new(), Vec::new(), String::new())];
    while let Some((folder, folder_key, folder_shown)) = folders.pop() {
        let listing = match fs::read_dir(workspace_root.join(&folder)) {
            Ok(listing) => listing,
            Err(error) if is_gone(&error) => continue,
            Err(error) => return Err(error),
        };
        for listed in listing {
            let listed = listed?;
            let name = listed.file_name();
            if folder_key.is_empty() && name == GIT_METADATA_ENTRY_NAME {
                continue;
            }
            let relative = folder.join(&name);
            let key = record_key(&folder_key, &name);
            let shown = shown_path(&folder_shown, &name);
            if listed.file_type()?.is_dir() {
                if workspace_root.join(&relative) != working_tree {
                    folders.push((relative, key, shown));
                }
            } else {
                entries.push(WorkspaceEntry {
                    relative,
                    key,
                    shown,
                });
            }
        }
    }
    entries.sort_by(|left, right| left.key.cmp(&right.key));
    Ok(entries)
}

// The record key of `name` in the folder keyed `folder_key`: the name's stable bytes, never a text
// form, so two names take two keys whatever they hold and the same name keeps its key across
// builds.
fn record_key(folder_key: &[u8], name: &OsStr) -> Vec<u8> {
    let mut key = folder_key.to_vec();
    if !key.is_empty() {
        key.extend_from_slice(&os_text_stable_bytes(OsStr::new("/")));
    }
    key.extend_from_slice(&os_text_stable_bytes(name));
    key
}

fn shown_path(folder_shown: &str, name: &OsStr) -> String {
    let name = name.to_string_lossy();
    if folder_shown.is_empty() {
        name.into_owned()
    } else {
        format!("{folder_shown}/{name}")
    }
}

// Copies one regular file, never replacing anything: the copy is written beside the target, then
// published under the target's name without replacing, so a path the repository already holds, a
// link there included, is skipped, and takes the source's permissions once it has the name.
async fn copy_entry(
    folders: &ConversionFolders,
    entry: &WorkspaceEntry,
) -> Result<EntryOutcome, SessionConversionError> {
    let workspace_root = folders.workspace_root.clone();
    let working_tree = folders.working_tree.clone();
    let relative = entry.relative.clone();
    let copy_name = copy_name_of(folders.session_id);
    let written = on_blocking_thread(move || {
        write_copy(&workspace_root, &working_tree, &relative, &copy_name)
    })
    .await?;
    let (copy_path, target, permissions) = match written {
        WrittenCopy::Written {
            copy_path,
            target,
            permissions,
        } => (copy_path, target, permissions),
        WrittenCopy::Skipped(reason) => return Ok(EntryOutcome::Skipped(reason)),
        WrittenCopy::Gone => return Ok(EntryOutcome::Gone),
    };
    match publish_without_replacing(&copy_path, &target).await? {
        PublishOutcome::Published => {
            tokio::fs::set_permissions(&target, permissions)
                .await
                .map_err(SessionConversionError::File)?;
            Ok(EntryOutcome::Copied)
        }
        PublishOutcome::TargetExists => Ok(EntryOutcome::Skipped(
            SessionConvertSkipReason::RepositoryHasFile,
        )),
    }
}

// Opens the source through no link in its path under the workspace, and writes its bytes to a new
// file named `copy_name` in the target's folder, each folder on the way a real folder of the
// repository, made when missing. A failed write removes the copy, so the repository keeps no part
// of the file.
fn write_copy(
    workspace_root: &Path,
    working_tree: &Path,
    relative: &Path,
    copy_name: &str,
) -> Result<WrittenCopy, SessionConversionError> {
    let opened =
        open_regular_file(workspace_root, relative).map_err(SessionConversionError::File)?;
    let mut source = match opened {
        RegularFileOpen::Opened(file) => file,
        RegularFileOpen::Link => return Ok(WrittenCopy::Skipped(SessionConvertSkipReason::Link)),
        RegularFileOpen::SpecialFile => {
            return Ok(WrittenCopy::Skipped(SessionConvertSkipReason::SpecialFile));
        }
        RegularFileOpen::Gone => return Ok(WrittenCopy::Gone),
    };
    let mut folder = working_tree.to_path_buf();
    if let Some(parent) = relative.parent() {
        for component in parent.components() {
            folder.push(component);
            if !holds_own_folder(&folder).map_err(SessionConversionError::File)? {
                return Ok(WrittenCopy::Skipped(
                    SessionConvertSkipReason::RepositoryPathNotAFolder,
                ));
            }
        }
    }
    let permissions = source
        .metadata()
        .map_err(SessionConversionError::File)?
        .permissions();
    let copy_path = folder.join(copy_name);
    let mut copy = create_new_file(&copy_path, COPY_MODE).map_err(SessionConversionError::File)?;
    if let Err(failure) = io::copy(&mut source, &mut copy) {
        drop(copy);
        let removal = fs::remove_file(&copy_path).err();
        return Err(CleanupFailures::new(failure, removal.into_iter().collect(), COPYING).into());
    }
    Ok(WrittenCopy::Written {
        copy_path,
        target: working_tree.join(relative),
        permissions,
    })
}

// Whether `folder` is a real folder of the repository, made when missing. A link or a file there
// means the repository holds that path, and a link is never written through.
fn holds_own_folder(folder: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(folder) {
        Ok(metadata) => return Ok(metadata.is_dir()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    match fs::create_dir(folder) {
        Ok(()) => Ok(true),
        // Made meanwhile; only a real folder holds the copy.
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            Ok(fs::symlink_metadata(folder)?.is_dir())
        }
        Err(error) => Err(error),
    }
}

fn copy_name_of(session_id: SessionId) -> String {
    format!(
        "{COPY_IN_PROGRESS_NAME_PREFIX}{}",
        session_id.text().as_str()
    )
}

fn record_file_statement(
    session_id: SessionId,
    entry: &WorkspaceEntry,
    outcome: &str,
) -> WriteStatement {
    WriteStatement {
        sql: RECORD_FILE_SQL.into(),
        bindings: StatementBindings::Named(vec![
            text_binding("@session_id", session_id.text().as_str()),
            (Cow::Borrowed("@path_key"), Value::Blob(entry.key.clone())),
            text_binding("@path", &entry.shown),
            text_binding("@outcome", outcome),
        ]),
        expected_row_count: Some(1),
    }
}

// Runs `work` off the async workers.
async fn on_blocking_thread<Output: Send + 'static>(
    work: impl FnOnce() -> Result<Output, SessionConversionError> + Send + 'static,
) -> Result<Output, SessionConversionError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|join| SessionConversionError::File(io::Error::other(join)))?
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;

    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use sidekicks_platforms::{non_unicode_name, os_text_stable_bytes};

    use super::record_key;

    // Fails with a name keyed by a text form: two names differing only in a byte that is not
    // Unicode read as one key under the lossy form, and a name that is not Unicode shares its key
    // with the Unicode name spelling its base64url under the encoded form. Either way the second
    // file's record is refused, which leaves the conversion incomplete on every resume.
    #[test]
    fn every_two_names_in_a_folder_take_two_keys() {
        let folder = record_key(&[], OsStr::new("notes"));
        let not_unicode = non_unicode_name("caf", 0);
        let spelled = URL_SAFE_NO_PAD.encode(os_text_stable_bytes(&not_unicode));

        let first = record_key(&folder, &not_unicode);
        assert_ne!(first, record_key(&folder, &non_unicode_name("caf", 1)));
        assert_ne!(first, record_key(&folder, OsStr::new(&spelled)));
        assert_eq!(
            record_key(&folder, OsStr::new("plain.txt")),
            os_text_stable_bytes(OsStr::new("notes/plain.txt")).into_owned()
        );
    }
}
