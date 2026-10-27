//! The store's files copied aside, untouched, before anything repairs them: the database, its
//! write-ahead log and its shared-memory index, each as it stands, into a folder of its own under
//! the data folder, as a clone where the file system can make one, each flushed to disk by its copy
//! before anything removes the files it copies. Nothing the repair does ever deletes a copy. Each
//! copy's folder keeps a record of the files' sizes and times as they were copied and of the
//! damaged sessions healed after it, so a start that meets the same damage again finds that copy
//! rather than making another. A stop ends a copy at once and removes what it had copied.

use std::error::Error;
use std::ffi::OsStr;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_platforms::{create_private_folder, file_facts, flush_folder, remove_tree};
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::file::atomic_write::{AtomicWriteError, write_file_atomically};
use sidekicks_std::missing_entry::MissingEntry as _;
use sidekicks_std::random_hex::random_hex;
use tokio::task::JoinError;
use tokio_util::sync::CancellationToken;
use tracing::warn;

use crate::database_file::copy::{DatabaseCopyError, DatabaseFileCopier};
use crate::database_file::{SHARED_MEMORY_SUFFIX, WRITE_AHEAD_LOG_SUFFIX, store_folder};

/// The two files SQLite keeps beside a database in write-ahead-log mode.
pub(crate) const DATABASE_COMPANION_FILE_SUFFIXES: [&str; 2] =
    [WRITE_AHEAD_LOG_SUFFIX, SHARED_MEMORY_SUFFIX];

// The folder inside the data folder that holds each copy, one folder per copy.
const ASIDE_FOLDER_NAME: &str = "damaged";

// The record beside each copy's files, the person's alone.
const RECORD_FILE_NAME: &str = "copy.json";
const RECORD_FILE_MODE: u32 = 0o600;

// The random bytes that keep two copies' folders apart.
const FOLDER_SUFFIX_BYTES: usize = 6;

/// Where the store's files are, where copies go, the copy every file is copied with, and the time
/// a new copy's folder is named for.
pub struct DatabaseFilesAside<'a> {
    /// The database file; its companions sit beside it.
    pub database_path: &'a Path,
    /// The data folder the copies' folder sits in.
    pub data_folder: &'a Path,
    /// The `database copy` mode each file is copied in.
    pub copier: &'a DatabaseFileCopier,
    /// The time a new copy's folder is named for.
    pub now: jiff::Timestamp,
}

/// Why the store's files could not be copied aside, or a copy's record read or written.
#[derive(Debug, thiserror::Error)]
pub enum AsideCopyError {
    /// The file system refused a read of the store's files or of a copy.
    #[error("the store's files or a copy of them could not be read")]
    Read(#[source] io::Error),
    /// The system gave no random bytes for the copy's folder's name.
    #[error("the copy's folder could not be named")]
    Naming(#[source] getrandom::Error),
    /// The time is before the year 0000, which a folder's name cannot write.
    #[error("a copy's folder is named for its time, and {0} cannot be written")]
    Time(jiff::Timestamp),
    /// The copies' folder or the copy's own folder could not be made, or flushed to disk.
    #[error("the copy's folder could not be made or flushed")]
    Folder(#[source] io::Error),
    /// One file's copy failed or was stopped.
    #[error("copying {name} aside failed")]
    Copy {
        /// The file's name.
        name: String,
        /// The copy's failure.
        #[source]
        source: DatabaseCopyError,
    },
    /// The copy's record does not parse.
    #[error("the copy's record does not parse")]
    RecordParse(#[source] serde_json::Error),
    /// The copy's record could not be written.
    #[error("the copy's record could not be written")]
    RecordWrite(#[source] AtomicWriteError),
    /// A blocking file-system task ended before it finished.
    #[error("a file-system task on the copy ended before it finished")]
    Interrupted(#[source] JoinError),
    /// The copy failed, and removing its folder failed too.
    #[error(transparent)]
    Cleanup(Box<CleanupFailures<AsideCopyError, io::Error>>),
}

/// One file of a copy as it stood when it was copied.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredFile {
    name: String,
    size: u64,
    // Its modification time, in nanoseconds since the Unix epoch.
    modified_at: i128,
}

/// A damaged session healed after a copy, with the head its damage left.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecordedSession {
    session_id: SessionId,
    head_sequence: i64,
}

/// The record beside a copy's files.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AsideCopyRecord {
    files: Vec<StoredFile>,
    sessions: Vec<RecordedSession>,
}

/// The folder of a copy of the database and its companion files as they stand now: an earlier
/// copy whose record matches them, or a new one, readable by the person alone and on disk. Fails
/// with the file system's error, and with the copy's [`DatabaseCopyError::Stopped`] once `stop`
/// fires, the new folder removed either way; a copy never overwrites another.
pub async fn copy_database_files_aside(
    aside: &DatabaseFilesAside<'_>,
    stop: &CancellationToken,
) -> Result<PathBuf, AsideCopyError> {
    let files = describe_database_files(aside.database_path).await?;
    for (folder, record) in read_aside_copies(aside.data_folder)
        .await
        .map_err(AsideCopyError::Read)?
    {
        if is_same_files(&record.files, &files) {
            return Ok(folder);
        }
    }
    let aside_root = aside.data_folder.join(ASIDE_FOLDER_NAME);
    run_folder_call({
        let aside_root = aside_root.clone();
        move || create_private_folder(&aside_root)
    })
    .await?;
    let instant = WireInstant::from_timestamp(aside.now).ok_or(AsideCopyError::Time(aside.now))?;
    let suffix = random_hex(FOLDER_SUFFIX_BYTES).map_err(AsideCopyError::Naming)?;
    // A colon is no part of a Windows file name; the random tail keeps two copies apart.
    let folder = aside_root.join(format!("{}-{suffix}", instant.as_str().replace(':', "-")));
    tokio::fs::create_dir(&folder)
        .await
        .map_err(AsideCopyError::Folder)?;
    let copied = async {
        run_folder_call({
            let folder = folder.clone();
            move || create_private_folder(&folder)
        })
        .await?;
        copy_files_into(&folder, &files, aside, stop).await
    }
    .await;
    if let Err(failure) = copied {
        let removing = folder.clone();
        let removed = tokio::task::spawn_blocking(move || remove_tree(&removing))
            .await
            .unwrap_or_else(|interrupted| Err(io::Error::other(interrupted)));
        return Err(match removed {
            Ok(()) => failure,
            Err(removal_failure) => AsideCopyError::Cleanup(Box::new(CleanupFailures::new(
                failure,
                vec![removal_failure],
                "copying the store's files aside",
            ))),
        });
    }
    // The new folder's entry, and the copies' folder's own in the data folder, which a first copy
    // made, so the copy is found after a power loss.
    let data_folder = aside.data_folder.to_path_buf();
    run_folder_call(move || {
        flush_folder(&aside_root)?;
        flush_folder(&data_folder)
    })
    .await?;
    Ok(folder)
}

/// The folder of a copy taken while the session `session_id` was damaged with its head at
/// `head_sequence`, so the same damage needs no second copy; `None` when there is none. Fails when
/// the copies' folder cannot be read.
pub(crate) async fn find_aside_copy_of_session(
    data_folder: &Path,
    session_id: &SessionId,
    head_sequence: i64,
) -> io::Result<Option<PathBuf>> {
    Ok(read_aside_copies(data_folder)
        .await?
        .into_iter()
        .find(|(_, record)| {
            record.sessions.iter().any(|session| {
                session.session_id == *session_id && session.head_sequence == head_sequence
            })
        })
        .map(|(folder, _)| folder))
}

/// Records in the copy at `folder` that it holds the session `session_id`, damaged with its head at
/// `head_sequence`. Fails when the copy's record cannot be read, does not parse or cannot be
/// written.
pub(crate) async fn record_session_in_aside_copy(
    folder: &Path,
    session_id: &SessionId,
    head_sequence: i64,
) -> Result<(), AsideCopyError> {
    let mut record = read_record(folder).await?;
    record.sessions.push(RecordedSession {
        session_id: *session_id,
        head_sequence,
    });
    write_record(folder, &record).await
}

// A clone keeps the bytes as they were when the file is replaced, at no cost in time or space. The
// log goes when the last connection closes, folded into the file first, so the companions are
// copied before the file: a log gone by its copy is in the file copied after it. Each copy is on
// disk when its mode answers, before the record names it.
async fn copy_files_into(
    folder: &Path,
    files: &[StoredFile],
    aside: &DatabaseFilesAside<'_>,
    stop: &CancellationToken,
) -> Result<(), AsideCopyError> {
    let store_folder = store_folder(aside.database_path);
    let database_name = database_file_name(aside.database_path).map_err(AsideCopyError::Read)?;
    let mut copied = Vec::with_capacity(files.len());
    for file in files.iter().rev() {
        let source = store_folder.join(&file.name);
        let copied_file = aside
            .copier
            .copy_file(&source, &folder.join(&file.name), stop)
            .await;
        if let Err(source_failure) = copied_file {
            // A companion the last close removed since the listing is passed over.
            let is_gone = !stop.is_cancelled()
                && file.name != database_name
                && !tokio::fs::try_exists(&source)
                    .await
                    .map_err(AsideCopyError::Read)?;
            if is_gone {
                continue;
            }
            return Err(AsideCopyError::Copy {
                name: file.name.clone(),
                source: source_failure,
            });
        }
        copied.push(file.clone());
    }
    write_record(
        folder,
        &AsideCopyRecord {
            files: copied,
            sessions: Vec::new(),
        },
    )
    .await
}

// The database and the companion files that exist, with their sizes and times, each read from one
// stat on the blocking pool.
async fn describe_database_files(database_path: &Path) -> Result<Vec<StoredFile>, AsideCopyError> {
    let store_folder = store_folder(database_path).to_path_buf();
    let database_name = database_file_name(database_path)
        .map_err(AsideCopyError::Read)?
        .to_owned();
    tokio::task::spawn_blocking(move || {
        let mut files = Vec::with_capacity(1 + DATABASE_COMPANION_FILE_SUFFIXES.len());
        let names = std::iter::once(database_name.clone()).chain(
            DATABASE_COMPANION_FILE_SUFFIXES
                .iter()
                .map(|suffix| format!("{database_name}{suffix}")),
        );
        for name in names {
            let facts = file_facts(&store_folder.join(&name));
            // A database closed cleanly keeps no log beside it.
            let facts = if name == database_name {
                Some(facts?)
            } else {
                facts.none_if_missing()?
            };
            let Some(facts) = facts else {
                continue;
            };
            files.push(StoredFile {
                name,
                size: facts.size,
                modified_at: facts.modified,
            });
        }
        Ok(files)
    })
    .await
    .map_err(AsideCopyError::Interrupted)?
    .map_err(AsideCopyError::Read)
}

// Whether a copy's recorded files are the files as they stand, in any order.
fn is_same_files(recorded: &[StoredFile], current: &[StoredFile]) -> bool {
    recorded.len() == current.len() && current.iter().all(|file| recorded.contains(file))
}

// Every earlier copy with a record that reads; one whose record does not is named in the log and
// never reused.
async fn read_aside_copies(data_folder: &Path) -> io::Result<Vec<(PathBuf, AsideCopyRecord)>> {
    let Some(mut entries) = tokio::fs::read_dir(data_folder.join(ASIDE_FOLDER_NAME))
        .await
        .none_if_missing()?
    else {
        return Ok(Vec::new());
    };
    let mut copies = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        if !entry.file_type().await?.is_dir() {
            continue;
        }
        let folder = entry.path();
        match read_record(&folder).await {
            Ok(record) => copies.push((folder, record)),
            Err(error) => warn!(
                folder = %folder.display(),
                error = &error as &(dyn Error + 'static),
                "the copy aside has no record that reads and is not reused"
            ),
        }
    }
    Ok(copies)
}

// The record of the copy at `folder`, read strictly.
async fn read_record(folder: &Path) -> Result<AsideCopyRecord, AsideCopyError> {
    let bytes = tokio::fs::read(folder.join(RECORD_FILE_NAME))
        .await
        .map_err(AsideCopyError::Read)?;
    serde_json::from_slice(&bytes).map_err(AsideCopyError::RecordParse)
}

// Replaces the record of the copy at `folder`, durably.
async fn write_record(folder: &Path, record: &AsideCopyRecord) -> Result<(), AsideCopyError> {
    let bytes = serde_json::to_vec(record).expect("a record of strings and integers serializes");
    write_file_atomically(&folder.join(RECORD_FILE_NAME), bytes, RECORD_FILE_MODE)
        .await
        .map_err(AsideCopyError::RecordWrite)
}

/// The name of the database file, or a copy beside it, which the daemon gives in UTF-8. Fails with
/// `InvalidInput` when the path has no name or one that is not UTF-8.
pub(crate) fn database_file_name(database_path: &Path) -> io::Result<&str> {
    database_path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| {
            io::Error::new(
                ErrorKind::InvalidInput,
                "the database file's path has no UTF-8 name",
            )
        })
}

// Runs a blocking call on a folder on the blocking pool.
async fn run_folder_call(
    call: impl FnOnce() -> io::Result<()> + Send + 'static,
) -> Result<(), AsideCopyError> {
    tokio::task::spawn_blocking(call)
        .await
        .map_err(AsideCopyError::Interrupted)?
        .map_err(AsideCopyError::Folder)
}
