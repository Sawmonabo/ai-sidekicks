//! The `database restore` mode: the service's store and the person's kept files put back from one
//! backup, run with the service stopped, since it replaces the file the service holds. It makes
//! the data folder when it is missing and takes its lock, so it is refused while a service runs;
//! reads the backup's manifest; reads the backup's database header, refusing a copy another
//! build's schema wrote and naming both schemas and both service versions; and reads the mirror's
//! list and checks that each place it keeps, under this computer's home folder, can be written,
//! all before it replaces anything. It then replaces the store, its log, its shared memory and its
//! search index removed, brings each place the mirror keeps level with its copy, and records
//! `daemon.backup.restored` in the restored store through the one writer before any service opens
//! it. A restore that fails names its step and leaves what it had not reached as it was.

use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{self, Read as _};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;

use sidekicks_contracts::daemon::backup::{BACKUP_DATABASE_FILE_NAME, DaemonBackupRestoredPayload};
use sidekicks_contracts::event::envelope::{DAEMON_SCOPE_SENTINEL_SESSION_ID, EventOccurredAt};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::release_manifest::ReleaseVersion;
use sidekicks_platforms::{create_private_folder, flush_folder, remove_tree, rename_replacing};
use tokio_util::sync::CancellationToken;

use crate::daemon::backup::mirror::{
    MIRROR_FOLDER_NAME, MIRROR_ROOTS_FILE_NAME, MirrorError, MirrorRoot, bring_level,
    probe_time_precision,
};
use crate::daemon::data_folder::data_folder;
use crate::daemon::data_folder_lock::{DataFolderLock, DataFolderLockError};
use crate::daemon::release_version::this_build_release_version;
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::connection::writer_open::{
    DAEMON_DATABASE_FILE_NAME, SEARCH_INDEX_FOLDER_NAME, open_database,
};
use crate::database::schema::DAEMON_SCHEMA_FINGERPRINT;
use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use crate::error_description::describe_error;
use crate::events::log_service::{
    EventLogAppendOptions, EventLogService, EventLogServiceDependencies,
};
use crate::events::session::appender::{SessionEventDraft, UnsequencedEventEnvelope};
use crate::events::session::followers::SessionEventFollowers;
use crate::events::session::version::SESSION_EVENT_VERSION;
use crate::helper_mode::error_output::write_error_line;
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

// The file a restore writes and removes in each place's folder to learn that it can write there.
const PLACE_PROBE_FILE_NAME: &str = ".sidekicks-restore-probe";

/// Why a restore failed, by its step.
#[derive(Debug, thiserror::Error)]
pub(crate) enum RestoreError {
    /// The home folder is unknown, so the data folder is.
    #[error("the home folder is unknown, so the service's data folder is too")]
    NoHome,
    /// The data folder could not be made.
    #[error("the service's data folder could not be made at {}", path.display())]
    DataFolder {
        /// The data folder.
        path: PathBuf,
        /// The system's failure.
        #[source]
        source: io::Error,
    },
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
        "the backup's store has schema {backup_schema_version}, written by service version \
         {backup_service_version}; this service version {build_service_version} reads schema \
         {build_schema_version}"
    )]
    OtherBuild {
        /// The schema the backup's copy names in its header.
        backup_schema_version: i32,
        /// The service version the backup's manifest names.
        backup_service_version: String,
        /// The schema this build reads.
        build_schema_version: i32,
        /// This build's service version.
        build_service_version: String,
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
    /// The mirror's list did not read, or names a place outside the home folder.
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
        write_error_line("the restore is started with the backup's folder");
        return ExitCode::FAILURE;
    };
    match restore_from_home(Path::new(backup_folder)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(failure) => {
            write_error_line(&format!("the restore failed: {}", describe_error(&failure)));
            ExitCode::FAILURE
        }
    }
}

// The mode's own start: this build's service version, the one each backup's manifest names for
// its own, and the home folder, handed to the restore.
fn restore_from_home(backup_folder: &Path) -> Result<(), RestoreError> {
    let service_version = this_build_release_version();
    let home = std::env::home_dir().ok_or(RestoreError::NoHome)?;
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(RestoreError::Runtime)?
        .block_on(restore_backup(&home, backup_folder, &service_version))
}

/// Restores the backup in `backup_folder` into the service of the home folder `home`, as the
/// mode's doc says, `service_version` this build's. Fails with the step that failed; before
/// anything is replaced with [`RestoreError::Lock`] while a service holds the data folder,
/// [`RestoreError::OtherBuild`] naming both schemas and both service versions, and
/// [`RestoreError::Place`] for a kept place that cannot be written.
pub(crate) async fn restore_backup(
    home: &Path,
    backup_folder: &Path,
    service_version: &ReleaseVersion,
) -> Result<(), RestoreError> {
    let data_folder = data_folder(home);
    let locked_folder = data_folder.clone();
    let _lock = tokio::task::spawn_blocking(move || {
        create_private_folder(&locked_folder).map_err(|source| RestoreError::DataFolder {
            path: locked_folder.clone(),
            source,
        })?;
        DataFolderLock::take(&locked_folder).map_err(RestoreError::Lock)
    })
    .await
    .map_err(|failure| RestoreError::Runtime(io::Error::other(failure)))??;
    let missing_manifest = |source| RestoreError::Manifest {
        backup: backup_folder.to_path_buf(),
        source,
    };
    let manifest = read_backup_manifest(backup_folder)
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
            backup_schema_version: backup_version,
            backup_service_version: manifest.service_version.as_str().to_owned(),
            build_schema_version: *DAEMON_SCHEMA_FINGERPRINT,
            build_service_version: service_version.as_str().to_owned(),
        });
    }
    let mirror_folder = backup_folder
        .parent()
        .map(|backups_folder| backups_folder.join(MIRROR_FOLDER_NAME));
    let kept = match &mirror_folder {
        Some(mirror_folder) => read_kept_places(mirror_folder, home)?,
        None => Vec::new(),
    };
    let store = data_folder.join(DAEMON_DATABASE_FILE_NAME);
    replace_store(
        &backup_database,
        &store,
        &data_folder.join(SEARCH_INDEX_FOLDER_NAME),
    )
    .map_err(|(path, source)| RestoreError::Replace { path, source })?;
    restore_mirror(&kept)?;
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

// Copies the backup's database beside the store, removes the store's log, its shared memory and
// the search index at `index_folder`, so no start opens an index of rows the restored store does
// not hold, and renames the copy over the store; answers the path a failure was at.
fn replace_store(
    backup_database: &Path,
    store: &Path,
    index_folder: &Path,
) -> Result<(), (PathBuf, io::Error)> {
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
    remove_tree(index_folder)
        .none_if_missing()
        .map_err(at(index_folder))?;
    rename_replacing(&restoring, store).map_err(at(store))?;
    let folder = store.parent().expect("the store's path names its folder");
    flush_folder(folder).map_err(at(folder))
}

// One place the restore puts back: the mirror's copy and the place under the home folder.
struct KeptPlace {
    copy: PathBuf,
    place: PathBuf,
}

// Reads the mirror's list and answers each place whose copy the mirror holds, under `home`, once
// every one of them is checked writable; nothing is written but each check's own file, removed
// again. A missing list keeps no place.
fn read_kept_places(mirror_folder: &Path, home: &Path) -> Result<Vec<KeptPlace>, RestoreError> {
    let Some(list) = fs::read(mirror_folder.join(MIRROR_ROOTS_FILE_NAME))
        .none_if_missing()
        .map_err(RestoreError::MirrorList)?
    else {
        return Ok(Vec::new());
    };
    let roots: Vec<MirrorRoot> = serde_json::from_slice(&list)
        .map_err(|failure| RestoreError::MirrorList(failure.into()))?;
    let mut kept = Vec::new();
    for root in roots {
        let copy = mirror_folder.join(root.name());
        if fs::symlink_metadata(&copy)
            .none_if_missing()
            .map_err(RestoreError::MirrorList)?
            .is_none()
        {
            continue;
        }
        let place = root.place(home);
        check_place_writable(&place).map_err(|(path, source)| RestoreError::Place {
            place: place.clone(),
            source: MirrorError::Io { path, source },
        })?;
        kept.push(KeptPlace { copy, place });
    }
    Ok(kept)
}

// Checks that the restore can write `place`: the nearest folder that exists on its way, or the
// folder holding it when it is a file, takes a file and lets it go. Answers the path a failure was
// at.
fn check_place_writable(place: &Path) -> Result<(), (PathBuf, io::Error)> {
    let mut written_folder = None;
    for ancestor in place.ancestors() {
        let Some(metadata) = fs::symlink_metadata(ancestor)
            .none_if_missing()
            .map_err(|failure| (ancestor.to_path_buf(), failure))?
        else {
            continue;
        };
        written_folder = Some(if metadata.is_dir() {
            ancestor
        } else if ancestor == place {
            place.parent().unwrap_or(place)
        } else {
            return Err((
                ancestor.to_path_buf(),
                io::Error::new(
                    io::ErrorKind::NotADirectory,
                    "a file stands where a folder goes",
                ),
            ));
        });
        break;
    }
    let folder = written_folder.unwrap_or(place);
    let probe = folder.join(PLACE_PROBE_FILE_NAME);
    File::create(&probe).map_err(|failure| (folder.to_path_buf(), failure))?;
    fs::remove_file(&probe).map_err(|failure| (probe, failure))
}

// Brings each kept place level with its copy, making the folders on its way, its times compared
// at the precision the place's folder keeps.
fn restore_mirror(kept: &[KeptPlace]) -> Result<(), RestoreError> {
    let stop = CancellationToken::new();
    for KeptPlace { copy, place } in kept {
        let failed = |source| RestoreError::Place {
            place: place.clone(),
            source,
        };
        let parent = place
            .parent()
            .expect("a kept place sits under the home folder");
        let in_parent = |failure| {
            failed(MirrorError::Io {
                path: parent.to_path_buf(),
                source: failure,
            })
        };
        fs::create_dir_all(parent).map_err(in_parent)?;
        let precision = probe_time_precision(parent).map_err(in_parent)?;
        bring_level(copy, place, precision, &stop).map_err(failed)?;
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

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use serde_json::json;
    use sidekicks_contracts::release_manifest::ReleaseVersion;

    use super::{BACKUP_DATABASE_FILE_NAME, RestoreError, restore_backup};
    use crate::daemon::data_folder::data_folder;
    use crate::daemon::data_folder_lock::DataFolderLock;
    use crate::database::connection::writer_open::{
        DAEMON_DATABASE_FILE_NAME, SEARCH_INDEX_FOLDER_NAME, open_database,
    };
    use crate::database::schema::DAEMON_SCHEMA_FINGERPRINT;

    // A backup folder holding a store this build opened, its `user_version` set to `version`, its
    // manifest naming `service_version`.
    fn write_backup(backup: &Path, version: i32, service_version: &str) {
        fs::create_dir_all(backup).expect("the backup's folder is made");
        let connection =
            open_database(&backup.join(BACKUP_DATABASE_FILE_NAME)).expect("the store opens");
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
            "serviceVersion": service_version,
            "totalBytes": 4096,
            "computerName": "Studio",
        });
        fs::write(
            backup.join("manifest.json"),
            serde_json::to_vec(&manifest).expect("a manifest writes"),
        )
        .expect("the manifest is written");
    }

    // Writes the mirror's list naming `roots`.
    fn write_mirror_list(backups: &Path, roots: &serde_json::Value) {
        fs::write(
            backups.join("mirror/roots.json"),
            serde_json::to_vec(roots).expect("the list writes"),
        )
        .expect("written");
    }

    // A restore makes a missing data folder and takes its lock, refusing a copy another build
    // wrote by naming both schemas and both service versions; it is refused while the folder is
    // held, and for a kept place it cannot write, each before the store is replaced. One that runs
    // leaves the store holding `daemon.backup.restored` on the service's own session, the search
    // index gone, and a kept file back under this home, whatever home wrote it. Killed by the
    // folder not made, by the lock skipped, by the version check skipped, by the places checked
    // after the store is replaced, by the index kept, and by the event written to the old store.
    #[tokio::test]
    async fn a_restore_is_refused_while_held_and_records_itself_in_the_restored_store() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let home = scratch.path().join("home");
        fs::create_dir_all(&home).expect("the home folder is made");
        let data_folder = data_folder(&home);
        let backups = scratch.path().join("backups");
        let other_build = backups.join("other-build");
        write_backup(&other_build, *DAEMON_SCHEMA_FINGERPRINT ^ 1, "9.9.9");
        let this_build = backups.join("this-build");
        write_backup(&this_build, *DAEMON_SCHEMA_FINGERPRINT, "1.2.3");
        let service_version = ReleaseVersion::new("1.2.3".to_owned()).expect("a version");
        fs::create_dir_all(backups.join("mirror/agent-memory")).expect("made");
        fs::write(backups.join("mirror/agent-memory/notes.md"), b"learned").expect("written");

        let refused = restore_backup(&home, &other_build, &service_version).await;
        let Err(refusal @ RestoreError::OtherBuild { .. }) = refused else {
            panic!("a copy another build wrote is refused, not {refused:?}");
        };
        let message = refusal.to_string();
        for named in [
            "9.9.9".to_owned(),
            "1.2.3".to_owned(),
            (*DAEMON_SCHEMA_FINGERPRINT ^ 1).to_string(),
            DAEMON_SCHEMA_FINGERPRINT.to_string(),
        ] {
            assert!(message.contains(&named), "{message} names {named}");
        }
        let store = data_folder.join(DAEMON_DATABASE_FILE_NAME);
        fs::write(&store, b"the store before the restore").expect("written");
        let index = data_folder.join(SEARCH_INDEX_FOLDER_NAME);
        fs::create_dir_all(&index).expect("the index folder is made");
        fs::write(index.join("segment"), b"rows of the store before").expect("written");
        let held = DataFolderLock::take(&data_folder).expect("the test holds the data folder");
        let refused = restore_backup(&home, &this_build, &service_version).await;
        assert!(matches!(refused, Err(RestoreError::Lock(_))));
        drop(held);
        fs::write(home.join("blocked"), b"a file where a folder goes").expect("written");
        write_mirror_list(
            &backups,
            &json!([{ "name": "agent-memory", "source": "blocked/agent-memory" }]),
        );
        let refused = restore_backup(&home, &this_build, &service_version).await;
        assert!(
            matches!(refused, Err(RestoreError::Place { .. })),
            "{refused:?}"
        );
        assert_eq!(
            fs::read(&store).expect("the store reads"),
            b"the store before the restore"
        );
        assert!(index.join("segment").exists());

        write_mirror_list(
            &backups,
            &json!([{ "name": "agent-memory", "source": ".agent/agent-memory" }]),
        );
        restore_backup(&home, &this_build, &service_version)
            .await
            .expect("the restore runs");
        assert!(!index.exists());

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
        assert_eq!(
            fs::read(home.join(".agent/agent-memory/notes.md")).expect("the kept file is back"),
            b"learned"
        );
    }
}
