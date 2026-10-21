//! The `database restore` mode: the service's store and the person's kept files put back from one
//! backup, run with the service stopped, since it replaces the file the service holds. It takes
//! the data folder's lock, so it is refused while a service runs; reads the backup's manifest; and
//! reads the backup's database header, refusing a copy another build's schema wrote, before it
//! replaces anything. It then replaces the store, its log and index removed, brings each place the
//! mirror keeps level with its copy, and records `daemon.backup.restored` in the restored store
//! through the one writer before any service opens it. A restore that fails names its step and
//! leaves what it had not reached as it was.

use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{self, Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;

use sidekicks_contracts::daemon::backup::{BACKUP_DATABASE_FILE_NAME, DaemonBackupRestoredPayload};
use sidekicks_contracts::daemon::data::DAEMON_DATA_FOLDER_NAME;
use sidekicks_contracts::event::envelope::{DAEMON_SCOPE_SENTINEL_SESSION_ID, EventOccurredAt};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_platforms::{flush_folder, rename_replacing};
use tokio_util::sync::CancellationToken;

use crate::daemon::backup::mirror::{
    MIRROR_FOLDER_NAME, MIRROR_ROOTS_FILE_NAME, MirrorError, MirrorRoot, bring_level,
};
use crate::daemon::data_folder_lock::{DataFolderLock, DataFolderLockError};
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::connection::writer_open::{DAEMON_DATABASE_FILE_NAME, open_database};
use crate::database::schema::DAEMON_SCHEMA_FINGERPRINT;
use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use crate::error_description::describe_error;
use crate::events::log_service::{
    EventLogAppendOptions, EventLogService, EventLogServiceDependencies,
};
use crate::events::session::appender::{SessionEventDraft, UnsequencedEventEnvelope};
use crate::events::session::followers::SessionEventFollowers;
use crate::events::session::version::SESSION_EVENT_VERSION;
use crate::missing_entry::MissingEntry as _;
use crate::recovery::database_file::copy::copy_file_replacing;
use crate::recovery::database_file::newest_backup::{BackupManifestError, read_backup_manifest};
use crate::recovery::database_file::{SHARED_MEMORY_SUFFIX, WRITE_AHEAD_LOG_SUFFIX, sibling_path};

/// The arguments the daemon's own program is started with to restore a backup; the backup's
/// folder follows them.
pub const DATABASE_RESTORE_MODE: [&str; 2] = ["database", "restore"];

// The SQLite file header's first bytes, and where in the header its `user_version` sits.
const SQLITE_HEADER_MAGIC: &[u8; 16] = b"SQLite format 3\0";
const USER_VERSION_OFFSET: usize = 60;
const HEADER_LENGTH: usize = 100;

// The suffix of the store's copy on its way to its place.
const RESTORING_SUFFIX: &str = ".restoring";

// The restore appends one event, unprepared.
const RESTORE_STATEMENT_CAPACITY: usize = 0;

/// Why a restore failed, by its step.
#[derive(Debug, thiserror::Error)]
pub(crate) enum RestoreError {
    /// The home folder is unknown, so the data folder is.
    #[error("the home folder is unknown, so the service's data folder is too")]
    NoHome,
    /// The data folder is held, by a running service among others.
    #[error("the service's data folder could not be taken; stop the service first")]
    Lock(#[source] DataFolderLockError),
    /// The backup's manifest is missing or does not read.
    #[error("{} holds no backup whose manifest reads", backup.display())]
    Manifest {
        /// The backup's folder.
        backup: PathBuf,
        /// The read's failure; none when there is no manifest.
        #[source]
        source: Option<BackupManifestError>,
    },
    /// The backup's database copy is not a SQLite file this restore can read.
    #[error("the backup's database copy {} does not read", path.display())]
    Header {
        /// The copy.
        path: PathBuf,
        /// The system's failure, or why the header is not SQLite's.
        #[source]
        source: io::Error,
    },
    /// Another build's schema wrote the backup's copy.
    #[error(
        "the backup was written by a build whose store version is {backup_version}, and this \
         build's is {build_version}"
    )]
    OtherBuild {
        /// The backup's version.
        backup_version: i32,
        /// This build's.
        build_version: i32,
    },
    /// The store could not be replaced.
    #[error("the service's store could not be replaced at {}", path.display())]
    Replace {
        /// Where.
        path: PathBuf,
        /// The system's failure.
        #[source]
        source: io::Error,
    },
    /// The mirror's list did not read.
    #[error("the backup's list of kept files did not read")]
    MirrorList(#[source] io::Error),
    /// A kept place could not be put back.
    #[error("{} could not be put back from the backup", place.display())]
    Place {
        /// The place.
        place: PathBuf,
        /// The failure.
        #[source]
        source: MirrorError,
    },
    /// The restored store did not open.
    #[error("the restored store did not open")]
    Open(#[source] Box<dyn std::error::Error + Send + Sync>),
    /// The restore's record did not append.
    #[error("the restore could not be recorded in the restored store")]
    Record(#[source] Box<dyn std::error::Error + Send + Sync>),
    /// The restored store's writer did not close cleanly after the record.
    #[error("the restored store did not close cleanly")]
    Close(#[source] Box<dyn std::error::Error + Send + Sync>),
    /// The mode's runtime did not start.
    #[error("the restore's runtime did not start")]
    Runtime(#[source] io::Error),
}

/// Runs the `database restore` mode on the argument after the mode's own: the backup's folder.
/// Exits 0 once the restore is recorded, 1 with its step on standard error when it fails.
pub fn run_database_restore(arguments: &[OsString]) -> ExitCode {
    let [backup_folder] = arguments else {
        write_line("The restore is started with the backup's folder");
        return ExitCode::FAILURE;
    };
    match restore_from_home(Path::new(backup_folder)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(failure) => {
            write_line(&format!("The restore failed: {}", describe_error(&failure)));
            ExitCode::FAILURE
        }
    }
}

fn restore_from_home(backup_folder: &Path) -> Result<(), RestoreError> {
    let data_folder = std::env::home_dir()
        .ok_or(RestoreError::NoHome)?
        .join(DAEMON_DATA_FOLDER_NAME);
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(RestoreError::Runtime)?
        .block_on(restore_backup(&data_folder, backup_folder))
}

/// Restores the backup in `backup_folder` into the service whose data folder is `data_folder`,
/// as the mode's doc says. Fails with the step that failed; [`RestoreError::Lock`] while a service
/// holds the folder and [`RestoreError::OtherBuild`] naming both versions before anything is
/// replaced.
pub(crate) async fn restore_backup(
    data_folder: &Path,
    backup_folder: &Path,
) -> Result<(), RestoreError> {
    let locked_folder = data_folder.to_path_buf();
    let _lock = tokio::task::spawn_blocking(move || DataFolderLock::take(&locked_folder))
        .await
        .map_err(|failure| RestoreError::Runtime(io::Error::other(failure)))?
        .map_err(RestoreError::Lock)?;
    let missing_manifest = |source| RestoreError::Manifest {
        backup: backup_folder.to_path_buf(),
        source,
    };
    let manifest = read_backup_manifest(backup_folder)
        .await
        .map_err(|failure| missing_manifest(Some(failure)))?
        .ok_or_else(|| missing_manifest(None))?;
    let backup_database = backup_folder.join(BACKUP_DATABASE_FILE_NAME);
    let backup_version =
        read_user_version(&backup_database).map_err(|source| RestoreError::Header {
            path: backup_database.clone(),
            source,
        })?;
    if backup_version != *DAEMON_SCHEMA_FINGERPRINT {
        return Err(RestoreError::OtherBuild {
            backup_version,
            build_version: *DAEMON_SCHEMA_FINGERPRINT,
        });
    }
    let store = data_folder.join(DAEMON_DATABASE_FILE_NAME);
    replace_store(&backup_database, &store)
        .map_err(|(path, source)| RestoreError::Replace { path, source })?;
    if let Some(backups_folder) = backup_folder.parent() {
        restore_mirror(&backups_folder.join(MIRROR_FOLDER_NAME))?;
    }
    record_restore(
        &store,
        SessionEvent::DaemonBackupRestored(DaemonBackupRestoredPayload {
            backup_id: manifest.backup_id,
            kept_distribution_parts: None,
        }),
    )
    .await
}

// The `user_version` the header of the SQLite file at `path` holds, read without opening the
// file through SQLite, which would make a log beside a copy that keeps a write-ahead-log mark.
fn read_user_version(path: &Path) -> io::Result<i32> {
    let mut header = [0_u8; HEADER_LENGTH];
    File::open(path)?.read_exact(&mut header)?;
    if !header.starts_with(SQLITE_HEADER_MAGIC) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "the file is not a SQLite database",
        ));
    }
    let bytes: [u8; 4] = header[USER_VERSION_OFFSET..USER_VERSION_OFFSET + 4]
        .try_into()
        .expect("the header holds four bytes there");
    Ok(i32::from_be_bytes(bytes))
}

// Copies the backup's database beside the store, removes the store's log and index, and renames
// the copy over the store; answers the path a failure was at.
fn replace_store(backup_database: &Path, store: &Path) -> Result<(), (PathBuf, io::Error)> {
    let at = |path: &Path| {
        let path = path.to_path_buf();
        move |failure| (path, failure)
    };
    let restoring = sibling_path(store, RESTORING_SUFFIX);
    copy_file_replacing(backup_database, &restoring).map_err(at(&restoring))?;
    for suffix in [WRITE_AHEAD_LOG_SUFFIX, SHARED_MEMORY_SUFFIX] {
        let companion = sibling_path(store, suffix);
        fs::remove_file(&companion)
            .none_if_missing()
            .map_err(at(&companion))?;
    }
    rename_replacing(&restoring, store).map_err(at(store))?;
    let folder = store.parent().expect("the store's path names its folder");
    flush_folder(folder).map_err(at(folder))
}

// Brings each place the mirror lists level with its copy; a place whose copy is missing is left
// as it is.
fn restore_mirror(mirror_folder: &Path) -> Result<(), RestoreError> {
    let Some(list) = fs::read(mirror_folder.join(MIRROR_ROOTS_FILE_NAME))
        .none_if_missing()
        .map_err(RestoreError::MirrorList)?
    else {
        return Ok(());
    };
    let roots: Vec<MirrorRoot> = serde_json::from_slice(&list)
        .map_err(|failure| RestoreError::MirrorList(failure.into()))?;
    let stop = CancellationToken::new();
    for root in roots {
        let copy = mirror_folder.join(&root.name);
        if fs::symlink_metadata(&copy)
            .none_if_missing()
            .map_err(RestoreError::MirrorList)?
            .is_none()
        {
            continue;
        }
        if let Some(parent) = root.source.parent() {
            fs::create_dir_all(parent).map_err(|failure| RestoreError::Place {
                place: root.source.clone(),
                source: MirrorError::Io {
                    path: parent.to_path_buf(),
                    source: failure,
                },
            })?;
        }
        bring_level(&copy, &root.source, &stop).map_err(|source| RestoreError::Place {
            place: root.source.clone(),
            source,
        })?;
    }
    Ok(())
}

// Appends `event` on the service's own session of the store at `store`, through the one writer,
// and closes it.
async fn record_restore(store: &Path, event: SessionEvent) -> Result<(), RestoreError> {
    let opened = store.to_path_buf();
    let writer = Arc::new(
        DatabaseWriter::open(
            move || open_database(&opened),
            DatabaseWriterOptions::default(),
        )
        .await
        .map_err(|failure| RestoreError::Open(Box::new(failure)))?,
    );
    let event_log = EventLogService::new(EventLogServiceDependencies {
        writer: Arc::clone(&writer),
        pool: Arc::new(DatabaseReadPool::new(
            store.to_path_buf(),
            RESTORE_STATEMENT_CAPACITY,
        )),
        followers: Arc::new(SessionEventFollowers::default()),
        projection_statements: None,
        refuse_session_write: None,
        read_damaged_from_sequence: None,
    });
    let draft = SessionEventDraft::of_session(*DAEMON_SCOPE_SENTINEL_SESSION_ID, &event)
        .map_err(|failure| RestoreError::Record(Box::new(failure)))?;
    let envelope = UnsequencedEventEnvelope::new(
        draft,
        EventOccurredAt::now(),
        None,
        None,
        SESSION_EVENT_VERSION.clone(),
    );
    let appended = event_log
        .append(envelope, EventLogAppendOptions::default())
        .await;
    let closed = writer.close(None).await;
    appended.map_err(|failure| RestoreError::Record(Box::new(failure)))?;
    closed.map_err(|failure| RestoreError::Close(Box::new(failure)))?;
    Ok(())
}

fn write_line(line: &str) {
    // Nothing is left to report a failed write to; the exit status still says it failed.
    if let Err(error) = writeln!(io::stderr().lock(), "{line}") {
        drop(error);
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use serde_json::json;

    use super::{RestoreError, restore_backup};
    use crate::daemon::data_folder_lock::DataFolderLock;
    use crate::database::connection::writer_open::open_database;
    use crate::database::schema::DAEMON_SCHEMA_FINGERPRINT;

    // A backup folder holding a store this build opened, its `user_version` set to `version`.
    fn write_backup(backup: &Path, version: i32) {
        fs::create_dir_all(backup).expect("the backup's folder is made");
        let connection = open_database(&backup.join("daemon.db")).expect("the store opens");
        connection
            .pragma_update(None, "user_version", version)
            .expect("the version is set");
        connection
            .close()
            .map_err(|(_connection, failure)| failure)
            .expect("the store closes");
        let manifest = json!({
            "backupId": "restored-backup",
            "takenAt": "2026-10-20T03:00:00.000Z",
            "appVersion": "0.1.0",
            "serviceVersion": "0.1.0",
            "totalBytes": 4096,
            "computerName": "Studio",
        });
        fs::write(
            backup.join("manifest.json"),
            serde_json::to_vec(&manifest).expect("a manifest writes"),
        )
        .expect("the manifest is written");
    }

    // A restore is refused while the data folder is held and for a copy another build wrote,
    // naming both versions, each before the store is replaced; one that runs leaves the store
    // holding `daemon.backup.restored` on the service's own session and puts a kept file back.
    // Killed by the lock skipped, by the version check skipped, and by the event written to the
    // old store.
    #[tokio::test]
    async fn a_restore_is_refused_while_held_and_records_itself_in_the_restored_store() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let data_folder = scratch.path().join("data");
        fs::create_dir_all(&data_folder).expect("the data folder is made");
        let store = data_folder.join("daemon.db");
        fs::write(&store, b"the store before the restore").expect("written");
        let backups = scratch.path().join("backups");
        let other_build = backups.join("other-build");
        write_backup(&other_build, *DAEMON_SCHEMA_FINGERPRINT ^ 1);
        let this_build = backups.join("this-build");
        write_backup(&this_build, *DAEMON_SCHEMA_FINGERPRINT);
        let notes = scratch.path().join("agent-memory/notes.md");
        fs::create_dir_all(backups.join("mirror/agent-memory")).expect("made");
        fs::write(backups.join("mirror/agent-memory/notes.md"), b"learned").expect("written");
        let roots = json!([{ "name": "agent-memory", "source": notes.parent() }]);
        fs::write(
            backups.join("mirror/roots.json"),
            serde_json::to_vec(&roots).expect("the list writes"),
        )
        .expect("written");

        let held = DataFolderLock::take(&data_folder).expect("the test holds the data folder");
        let refused = restore_backup(&data_folder, &this_build).await;
        assert!(matches!(refused, Err(RestoreError::Lock(_))));
        drop(held);
        let refused = restore_backup(&data_folder, &other_build).await;
        assert!(matches!(
            refused,
            Err(RestoreError::OtherBuild { backup_version, build_version })
                if backup_version == *DAEMON_SCHEMA_FINGERPRINT ^ 1
                    && build_version == *DAEMON_SCHEMA_FINGERPRINT
        ));
        assert_eq!(
            fs::read(&store).expect("the store reads"),
            b"the store before the restore"
        );

        restore_backup(&data_folder, &this_build)
            .await
            .expect("the restore runs");

        let restored = rusqlite::Connection::open(&store).expect("the restored store opens");
        let recorded: String = restored
            .query_row(
                "SELECT payload FROM session_events WHERE session_id = ?1 AND type = ?2",
                [
                    sidekicks_contracts::event::envelope::DAEMON_SCOPE_SENTINEL_SESSION_ID
                        .text()
                        .as_str(),
                    "daemon.backup.restored",
                ],
                |row| row.get(0),
            )
            .expect("the restored store holds the restore's record");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&recorded).expect("the payload reads"),
            json!({ "backupId": "restored-backup" })
        );
        assert_eq!(fs::read(&notes).expect("the kept file is back"), b"learned");
    }
}
