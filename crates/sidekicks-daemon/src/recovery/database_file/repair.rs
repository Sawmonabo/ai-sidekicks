//! The database file's repair at a start, before anything opens it for writing, of the damage a
//! run recorded beside it: the damaged file is copied aside untouched with its write-ahead log, its
//! rows are recovered into a fresh file with SQLite's own recovery, and where the person keeps a
//! backup that reads, each session whose events the newest backup holds more of takes them from it.
//! While the recovery runs, the repair reports how many of the damaged file's session events it has
//! recovered. The fresh file must hold exactly this build's schema and pass the full integrity
//! check, each step in the daemon's own SQLite shell, before it is flushed to disk and replaces the
//! damaged one; every session's projections are then rebuilt from its events, and the search
//! index, built from the damaged file's rows, is dropped to be built again from the fresh file's.
//! A marker written once the fresh file is ready lets a start that a crash cut short finish the
//! replacement rather than recover again from a file whose log is gone. A stop before that marker
//! ends the repair at once and leaves the damaged file, its record and its copy aside as they were,
//! so the next start repairs it again; from the marker on, the replacement finishes first.
//!
//! The files the repair writes beside the database file, the fresh file and the newest backup's
//! copy, go once it ends, after the replacement when it succeeds. One that cannot be removed then
//! is named beside the outcome, never undoing a repair or turning a stop into a failure; the next
//! repair removes what an earlier one left before it starts.
//!
//! The start makes two calls: the first finishes a replacement a crash cut short and reads the
//! damage record, and only when it names damage does the start answer that it is repairing and make
//! the second, which repairs the file.

use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};

use sidekicks_contracts::daemon::recovery::DaemonRepairProgress;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_platforms::{
    flush_file, flush_folder, physical_memory, remove_tree, rename_replacing,
};
use tokio::sync::watch;
use tokio::task::JoinError;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::cleanup_failures::CleanupFailures;
use crate::database::schema::DatabaseSchema;
use crate::database::sibling_path;
use crate::file::atomic_write::{AtomicWriteError, write_file_atomically};
use crate::missing_entry::MissingEntry as _;
use crate::recovery::database_file::aside_copy::{
    AsideCopyError, DATABASE_COMPANION_FILE_SUFFIXES, DatabaseFilesAside, copy_database_files_aside,
};
use crate::recovery::database_file::copy::{DatabaseCopyError, DatabaseFileCopier};
use crate::recovery::database_file::damage::{read_database_damage, remove_database_damage};
use crate::recovery::database_file::fresh::{
    FreshFileError, FreshFilePreparation, log_passed_over_backup, prepare_fresh_file,
};
use crate::recovery::database_file::last_run::{LastRunError, record_clean_stop};
use crate::recovery::database_file::newest_backup::find_newest_backup_database;
use crate::recovery::database_file::sqlite_shell::{SqliteRecoveryError, SqliteShell};
use crate::recovery::database_file::store_folder;

// The fresh file a repair recovers into, beside the database file.
const FRESH_FILE_SUFFIX: &str = ".recovered";

// The marker that says the fresh file is ready to replace the database file.
const READY_MARKER_SUFFIX: &str = ".recovered-ready";

// The rollback journal each step that readies the fresh file keeps beside it while it writes.
const FRESH_FILE_JOURNAL_SUFFIX: &str = ".recovered-journal";

// The copy of the newest backup's database the repair reads, beside the database file.
const BACKUP_COPY_SUFFIX: &str = ".backup-read";

// The marker holds nothing and is the person's alone.
const READY_MARKER_MODE: u32 = 0o600;

// The operation a failure's cleanup failures name.
const REPAIRING: &str = "the database file's repair";

// The removal a repair makes before any work, of the files an earlier one left.
const LEFTOVER_REMOVAL: &str =
    "removing the files an earlier repair wrote beside the database file";

/// What the repair reads and where it writes.
pub struct DatabaseFileRepairOptions<'a> {
    /// The database file.
    pub database_path: &'a Path,
    /// The data folder the copies aside go into.
    pub data_folder: &'a Path,
    /// The search index's folder, built from the database's rows; a replaced file drops it.
    pub index_folder_path: &'a Path,
    /// The daemon's SQLite shell, which recovers the file and readies the fresh one.
    pub shell: &'a SqliteShell,
    /// The `database copy` mode every copy runs in.
    pub copier: &'a DatabaseFileCopier,
    /// The schema the fresh file must hold.
    pub schema: &'a DatabaseSchema,
    /// The time a new copy aside is named for.
    pub now: jiff::Timestamp,
}

/// How a repair of a damaged file ended: replaced by a repaired one, left damaged as it was with
/// why, or ended by a stop first with the file as it was. The damaged file was copied aside first,
/// into `aside_folder`.
#[derive(Debug)]
pub enum DatabaseFileRepair {
    /// The repaired file replaced the damaged one.
    Repaired {
        /// The copy aside of the damaged file.
        aside_folder: PathBuf,
        /// The sessions whose events came from the newest backup.
        sessions_from_backup: u64,
        /// Each file the repair wrote beside the database file that could not be removed after
        /// the replacement, which the start logs; empty when every one went.
        leftovers: Vec<LeftoverFile>,
    },
    /// The file stays as it was and keeps its record, so the next start tries again.
    Unrepaired {
        /// The copy aside of the damaged file.
        aside_folder: PathBuf,
        /// Why it could not be repaired, beside each file of the repair that could not be removed
        /// after it.
        failure: CleanupFailures<DatabaseFileRepairFailure, LeftoverFile>,
    },
    /// A stop ended the repair; the file stays as it was and the next start repairs it.
    Stopped {
        /// Each file the repair wrote beside the database file that could not be removed once the
        /// stop came, which the start logs; empty when every one went.
        leftovers: Vec<LeftoverFile>,
    },
}

/// A file a repair wrote beside the database file that could not be removed, and why.
#[derive(Debug, thiserror::Error)]
#[error("{} could not be removed", path.display())]
pub struct LeftoverFile {
    /// The file that stayed.
    pub path: PathBuf,
    /// Why its removal failed.
    #[source]
    pub error: io::Error,
}

/// Why a damaged file could not be repaired.
#[derive(Debug, thiserror::Error)]
pub enum DatabaseFileRepairFailure {
    /// SQLite's recovery failed.
    #[error(transparent)]
    Recovery(SqliteRecoveryError),
    /// The fresh file could not be readied, or is not this build's or not sound.
    #[error(transparent)]
    FreshFile(FreshFileError),
    /// The fresh file could not be flushed to disk.
    #[error("the recovered file could not be flushed to disk")]
    Flush(#[source] io::Error),
    /// The flush's blocking task ended before it finished.
    #[error("the recovered file's flush ended before it finished")]
    Interrupted(#[source] JoinError),
}

/// Why the repair could not run, or the ready fresh file could not be put in place, which the next
/// start finishes.
#[derive(Debug, thiserror::Error)]
pub enum DatabaseFileRepairError {
    /// The damage record could not be read or removed.
    #[error("the database file's damage record could not be read or removed")]
    Damage(#[source] io::Error),
    /// The damaged file could not be copied aside at all.
    #[error("the damaged database file could not be copied aside")]
    AsideCopy(#[source] AsideCopyError),
    /// A file of the repair could not be read, removed, renamed or flushed.
    #[error("a file of the database file's repair could not be read, removed, moved or flushed")]
    File(#[source] io::Error),
    /// A file an earlier repair, cut short by a stop or a crash, left beside the database file
    /// could not be removed before any work: the first, beside the others, each naming its file.
    #[error("a file an earlier repair wrote beside the database file could not be removed")]
    Leftover(#[source] CleanupFailures<LeftoverFile>),
    /// The ready marker could not be written.
    #[error("the repaired file's ready marker could not be written")]
    Marker(#[source] AtomicWriteError),
    /// The repaired file could not be recorded as a clean stop records a file.
    #[error("the repaired file could not be recorded as checked whole")]
    LastRun(#[source] LastRunError),
    /// A blocking file-system task ended before it finished.
    #[error("a file-system task of the repair ended before it finished")]
    Interrupted(#[source] JoinError),
}

/// Finishes a replacement a crash cut short, then answers the damage a run recorded for this start
/// to repair, `None` when none was or the file is gone, whose record it removes with the files a
/// repair cut short left beside it. Fails when the record cannot be read or removed, or the ready
/// fresh file cannot be put in place, which the next start finishes; fails with
/// [`DatabaseFileRepairError::Leftover`] when a file a repair left beside a gone file stays.
pub async fn prepare_database_file_repair(
    options: &DatabaseFileRepairOptions<'_>,
) -> Result<Option<String>, DatabaseFileRepairError> {
    let database_path = options.database_path;
    let ready_marker_path = sibling_path(database_path, READY_MARKER_SUFFIX);
    if tokio::fs::try_exists(&ready_marker_path)
        .await
        .map_err(DatabaseFileRepairError::File)?
    {
        info!("a repaired database file was ready; its replacement is finished now");
        replace_database_file(options).await?;
    }
    let Some(damage) = read_database_damage(database_path)
        .await
        .map_err(DatabaseFileRepairError::Damage)?
    else {
        return Ok(None);
    };
    if !tokio::fs::try_exists(database_path)
        .await
        .map_err(DatabaseFileRepairError::File)?
    {
        // No repair runs, so the files one cut short left go here, before the record, which a
        // start that cannot remove them keeps to try again.
        require_all_removed(remove_repair_files(database_path).await)?;
        remove_database_damage(database_path)
            .await
            .map_err(DatabaseFileRepairError::Damage)?;
        return Ok(None);
    }
    Ok(Some(damage))
}

/// Repairs the damaged file `damage` describes, as [`prepare_database_file_repair`] answered it,
/// reading the newest backup in `backup_folder`, where the person keeps backups, and sending on
/// `progress` how many of the damaged file's session events it has recovered, `None` while the
/// step it is on gives no count. A file it could not repair comes back
/// [`DatabaseFileRepair::Unrepaired`], and one `stop` reached before the ready marker comes back
/// [`DatabaseFileRepair::Stopped`], each left in place with its record; each outcome names the
/// files the repair wrote that could not be removed after it. Fails when the file cannot be copied
/// aside at all, or the ready fresh file cannot be put in place, which the next start finishes.
/// Fails with [`DatabaseFileRepairError::Leftover`] when a file an earlier repair left cannot be
/// removed before this one starts.
pub async fn repair_damaged_file(
    options: &DatabaseFileRepairOptions<'_>,
    damage: &str,
    backup_folder: &Path,
    progress: &watch::Sender<Option<DaemonRepairProgress>>,
    stop: &CancellationToken,
) -> Result<DatabaseFileRepair, DatabaseFileRepairError> {
    let database_path = options.database_path;
    let fresh_path = sibling_path(database_path, FRESH_FILE_SUFFIX);
    warn!(damage, "the database file is damaged");
    let aside = DatabaseFilesAside {
        database_path,
        data_folder: options.data_folder,
        copier: options.copier,
        now: options.now,
    };
    let aside_folder = match copy_database_files_aside(&aside, stop).await {
        Ok(aside_folder) => aside_folder,
        Err(_) if stop.is_cancelled() => return Ok(stopped_repair(Vec::new())),
        Err(error) => return Err(DatabaseFileRepairError::AsideCopy(error)),
    };
    info!(
        aside_folder = %aside_folder.display(),
        "the damaged database's files are copied aside"
    );
    // A repair a stop or a crash cut short may have left a fresh file and its journal, which SQLite
    // would otherwise roll back into the new one, and the newest backup's copy.
    require_all_removed(remove_repair_files(database_path).await)?;
    let readied = Box::pin(ready_fresh_file(
        options,
        &fresh_path,
        backup_folder,
        progress,
        stop,
    ))
    .await;
    progress.send_replace(None);
    // Every shell has exited, so nothing writes the repair's files from here on.
    let sessions_from_backup = match readied {
        Ok(sessions_from_backup) if !stop.is_cancelled() => sessions_from_backup,
        Err(ReadyingEnd::Failed(failure)) if !stop.is_cancelled() => {
            // The log names why and where the copy aside is before the repair's files are removed.
            warn!(
                error = &failure as &(dyn Error + 'static),
                aside_folder = %aside_folder.display(),
                "the database file could not be repaired"
            );
            let leftovers = remove_repair_files(database_path).await;
            return Ok(DatabaseFileRepair::Unrepaired {
                aside_folder,
                failure: CleanupFailures::new(failure, leftovers, REPAIRING),
            });
        }
        Ok(_) | Err(ReadyingEnd::Stopped | ReadyingEnd::Failed(_)) => {
            return Ok(stopped_repair(remove_repair_files(database_path).await));
        }
    };
    // From the marker on, a failure is the caller's rather than a failed repair: the fresh file
    // stays, and the next start finishes the replacement.
    write_file_atomically(
        &sibling_path(database_path, READY_MARKER_SUFFIX),
        "",
        READY_MARKER_MODE,
    )
    .await
    .map_err(DatabaseFileRepairError::Marker)?;
    replace_database_file(options).await?;
    info!(
        sessions_from_backup,
        "the database file was recovered; sessions took their events from the newest backup"
    );
    // The repair's files go only once the fresh file is in place, so no removal undoes the repair.
    Ok(DatabaseFileRepair::Repaired {
        aside_folder,
        sessions_from_backup,
        leftovers: remove_repair_files(database_path).await,
    })
}

// How readying the fresh file ended short of a ready file.
enum ReadyingEnd {
    Stopped,
    Failed(DatabaseFileRepairFailure),
}

// Recovers the damaged file into the fresh one, readies it with the newest backup and flushes it
// to disk, answering how many sessions came from the backup.
async fn ready_fresh_file(
    options: &DatabaseFileRepairOptions<'_>,
    fresh_path: &Path,
    backup_folder: &Path,
    progress: &watch::Sender<Option<DaemonRepairProgress>>,
    stop: &CancellationToken,
) -> Result<u64, ReadyingEnd> {
    match Box::pin(recover_counting_events(options, fresh_path, progress, stop)).await {
        Ok(()) => {}
        Err(SqliteRecoveryError::Stopped) => return Err(ReadyingEnd::Stopped),
        Err(error) => {
            return Err(ReadyingEnd::Failed(DatabaseFileRepairFailure::Recovery(
                error,
            )));
        }
    }
    progress.send_replace(None);
    let sessions_from_backup =
        match prepare_with_newest_backup(options, fresh_path, backup_folder, stop).await {
            Ok(sessions_from_backup) => sessions_from_backup,
            Err(FreshFileError::Stopped) => return Err(ReadyingEnd::Stopped),
            Err(error) => {
                return Err(ReadyingEnd::Failed(DatabaseFileRepairFailure::FreshFile(
                    error,
                )));
            }
        };
    // The recovery wrote with no syncs; the whole file reaches the disk before its marker.
    let flushing = fresh_path.to_path_buf();
    tokio::task::spawn_blocking(move || flush_file(&flushing))
        .await
        .map_err(|failure| ReadyingEnd::Failed(DatabaseFileRepairFailure::Interrupted(failure)))?
        .map_err(|failure| ReadyingEnd::Failed(DatabaseFileRepairFailure::Flush(failure)))?;
    Ok(sessions_from_backup)
}

// Recovers the damaged file into the fresh one, reporting how many of the damaged file's events
// are recovered once the file's own count of them is read. A count that cannot be read leaves the
// repair without one, and the log says why. The count serves only while the recovery runs, so its
// shell ends with the recovery.
async fn recover_counting_events(
    options: &DatabaseFileRepairOptions<'_>,
    fresh_path: &Path,
    progress: &watch::Sender<Option<DaemonRepairProgress>>,
    stop: &CancellationToken,
) -> Result<(), SqliteRecoveryError> {
    let (recovered_events, mut recovered) = watch::channel(0_u64);
    let (total_sender, mut total) = watch::channel(None::<SafeInt<0>>);
    let count_end = stop.child_token();
    let counting = async {
        match options
            .shell
            .count_damaged_file_events(options.database_path, &count_end)
            .await
        {
            Ok(count) => {
                total_sender.send_replace(Some(count));
            }
            Err(_) if count_end.is_cancelled() => {}
            Err(error) => warn!(
                error = &error as &(dyn Error + 'static),
                "the repair gives no count of its progress, as the damaged file's events could \
                 not be counted"
            ),
        }
    };
    let recovering = async {
        let recovered = Box::pin(options.shell.recover_into_fresh_file(
            options.database_path,
            fresh_path,
            physical_memory(),
            &recovered_events,
            stop,
        ))
        .await;
        count_end.cancel();
        recovered
    };
    let reporting = async {
        loop {
            tokio::select! {
                () = count_end.cancelled() => break,
                changed = recovered.changed() => if changed.is_err() { break },
                changed = total.changed() => if changed.is_err() { break },
            }
            let known_total = *total.borrow();
            if let Some(known_total) = known_total {
                let done = SafeInt::new((*recovered.borrow()).min(known_total.get()))
                    .expect("a count no greater than the total is a safe integer");
                progress.send_replace(Some(DaemonRepairProgress {
                    done,
                    total: known_total,
                }));
            }
        }
    };
    let ((), recovered, ()) = tokio::join!(counting, recovering, reporting);
    recovered
}

// Readies the fresh file with the newest backup's database, read from a copy beside the database
// file so nothing is written beside the person's backups, and answers how many sessions took their
// events from it. A backup that cannot be found or copied heals nothing, like no backup: the
// recovery alone heals the file, and the log says why the backup was passed over. A stop ends the
// copy, which the repair removes however the readying ends.
async fn prepare_with_newest_backup(
    options: &DatabaseFileRepairOptions<'_>,
    fresh_path: &Path,
    backup_folder: &Path,
    stop: &CancellationToken,
) -> Result<u64, FreshFileError> {
    let backup_copy_path = sibling_path(options.database_path, BACKUP_COPY_SUFFIX);
    let is_backup_copied =
        match copy_newest_backup(options, backup_folder, &backup_copy_path, stop).await {
            Ok(is_copied) => is_copied,
            Err(_) if stop.is_cancelled() => return Err(FreshFileError::Stopped),
            Err(error) => {
                log_passed_over_backup(&error);
                false
            }
        };
    prepare_fresh_file(
        &FreshFilePreparation {
            shell: options.shell,
            schema: options.schema,
            fresh_path,
            backup_copy_path: is_backup_copied.then_some(backup_copy_path.as_path()),
        },
        stop,
    )
    .await
}

// Why the newest backup's database could not be copied beside the database file.
#[derive(Debug, thiserror::Error)]
enum BackupCopyError {
    #[error("the backup folder could not be read")]
    Find(#[source] io::Error),
    #[error("the newest backup's database could not be copied")]
    Copy(#[source] DatabaseCopyError),
}

// Copies the newest backup's database beside the database file, as a clone where the file system
// makes one, so a large backup takes no time or space; answers whether there was one to copy.
async fn copy_newest_backup(
    options: &DatabaseFileRepairOptions<'_>,
    backup_folder: &Path,
    backup_copy_path: &Path,
    stop: &CancellationToken,
) -> Result<bool, BackupCopyError> {
    let searched = backup_folder.to_path_buf();
    let Some(backup_database) =
        tokio::task::spawn_blocking(move || find_newest_backup_database(&searched))
            .await
            .map_err(io::Error::other)
            .and_then(|found| found)
            .map_err(BackupCopyError::Find)?
    else {
        return Ok(false);
    };
    options
        .copier
        .copy_file(&backup_database, backup_copy_path, stop)
        .await
        .map_err(BackupCopyError::Copy)?;
    Ok(true)
}

fn stopped_repair(leftovers: Vec<LeftoverFile>) -> DatabaseFileRepair {
    info!(
        "the service's stop ended the repair; the damaged file stays as it was and its next start \
         repairs it"
    );
    DatabaseFileRepair::Stopped { leftovers }
}

// The files a repair writes beside the database file before its marker, by their suffixes: the
// fresh file and its journal, and the newest backup's copy with the companions SQLite may keep
// beside it.
fn repair_file_suffixes() -> impl Iterator<Item = String> {
    let backup_copy = std::iter::once("")
        .chain(DATABASE_COMPANION_FILE_SUFFIXES)
        .map(|companion| format!("{BACKUP_COPY_SUFFIX}{companion}"));
    [FRESH_FILE_SUFFIX, FRESH_FILE_JOURNAL_SUFFIX]
        .into_iter()
        .map(str::to_owned)
        .chain(backup_copy)
}

// Removes each of the repair's files that exists beside the database file, answering every one
// that could not be removed.
async fn remove_repair_files(database_path: &Path) -> Vec<LeftoverFile> {
    let mut leftovers = Vec::new();
    for suffix in repair_file_suffixes() {
        let path = sibling_path(database_path, &suffix);
        if let Err(error) = tokio::fs::remove_file(&path).await.none_if_missing() {
            leftovers.push(LeftoverFile { path, error });
        }
    }
    leftovers
}

// Fails with every file an earlier repair left that could not be removed: the first, beside the
// others.
fn require_all_removed(leftovers: Vec<LeftoverFile>) -> Result<(), DatabaseFileRepairError> {
    let mut leftovers = leftovers.into_iter();
    match leftovers.next() {
        None => Ok(()),
        Some(first) => Err(DatabaseFileRepairError::Leftover(CleanupFailures::new(
            first,
            leftovers.collect(),
            LEFTOVER_REMOVAL,
        ))),
    }
}

// The damaged file's log and index go first, so SQLite never replays them into the fresh file;
// both are in the aside copy. The search index goes too, before the rename, so no start opens an
// index of rows the fresh file lost or took from a backup. A start a crash cut short after the
// rename finds the fresh file already in place. The folder is flushed so the rename survives a
// power loss, and the file, checked whole, is recorded as a clean stop leaves one, so the start
// takes writes at once; the damage record then goes, and the marker last. Nothing here answers a
// stop.
async fn replace_database_file(
    options: &DatabaseFileRepairOptions<'_>,
) -> Result<(), DatabaseFileRepairError> {
    let database_path = options.database_path;
    let fresh_path = sibling_path(database_path, FRESH_FILE_SUFFIX);
    for suffix in DATABASE_COMPANION_FILE_SUFFIXES {
        tokio::fs::remove_file(sibling_path(database_path, suffix))
            .await
            .none_if_missing()
            .map_err(DatabaseFileRepairError::File)?;
    }
    let index_folder = options.index_folder_path.to_path_buf();
    run_file_call(move || remove_tree(&index_folder).none_if_missing().map(drop)).await?;
    if tokio::fs::try_exists(&fresh_path)
        .await
        .map_err(DatabaseFileRepairError::File)?
    {
        let replaced = database_path.to_path_buf();
        run_file_call(move || rename_replacing(&fresh_path, &replaced)).await?;
    }
    flush_store_folder(database_path).await?;
    record_clean_stop(database_path)
        .await
        .map_err(DatabaseFileRepairError::LastRun)?;
    remove_database_damage(database_path)
        .await
        .map_err(DatabaseFileRepairError::Damage)?;
    tokio::fs::remove_file(sibling_path(database_path, READY_MARKER_SUFFIX))
        .await
        .map_err(DatabaseFileRepairError::File)?;
    flush_store_folder(database_path).await
}

async fn flush_store_folder(database_path: &Path) -> Result<(), DatabaseFileRepairError> {
    let folder = store_folder(database_path).to_path_buf();
    run_file_call(move || flush_folder(&folder)).await
}

// Runs a blocking file-system call on the blocking pool.
async fn run_file_call(
    call: impl FnOnce() -> io::Result<()> + Send + 'static,
) -> Result<(), DatabaseFileRepairError> {
    tokio::task::spawn_blocking(call)
        .await
        .map_err(DatabaseFileRepairError::Interrupted)?
        .map_err(DatabaseFileRepairError::File)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use rstest::rstest;
    use sidekicks_platforms::Spawner;
    use tokio::runtime::Handle;

    use super::{
        DatabaseFileRepairOptions, FRESH_FILE_SUFFIX, READY_MARKER_SUFFIX,
        prepare_database_file_repair,
    };
    use crate::database::connection::writer_open::SEARCH_INDEX_FOLDER_NAME;
    use crate::database::schema::schema_parts;
    use crate::database::sibling_path;
    use crate::recovery::database_file::WRITE_AHEAD_LOG_SUFFIX;
    use crate::recovery::database_file::copy::DatabaseFileCopier;
    use crate::recovery::database_file::damage::{read_database_damage, record_database_damage};
    use crate::recovery::database_file::last_run::{LastRunEnd, read_last_run_end};
    use crate::recovery::database_file::sqlite_shell::SqliteShell;

    const DAMAGED_BYTES: &[u8] = b"the damaged file";
    const FRESH_BYTES: &[u8] = b"the recovered file";

    fn write(path: &Path, contents: &[u8]) {
        fs::write(path, contents).expect("the test writes its file");
    }

    // A crash cut the replacement short once the ready marker was written: before the rename, with
    // the fresh file beside the damaged one, its log and the search index; or after it, with the
    // fresh file in place. Either way the next start finishes the replacement and recovers nothing
    // again: the fresh file is the database, the damaged file's log, the search index, the damage
    // record and the marker are gone, and the file is recorded as a clean stop records it. A
    // replacement that skips the rename, keeps the log, keeps the record or skips the clean stop
    // fails a case, as does a start that reads the marker as no replacement owed.
    #[rstest]
    #[case::before_the_rename(false)]
    #[case::after_the_rename(true)]
    #[tokio::test]
    async fn a_replacement_a_crash_cut_short_is_finished_never_recovered_again(
        #[case] is_renamed: bool,
    ) {
        let data_folder = tempfile::tempdir().expect("a data folder");
        let database_path = data_folder.path().join("daemon.db");
        let index_folder_path = data_folder.path().join(SEARCH_INDEX_FOLDER_NAME);
        fs::create_dir(&index_folder_path).expect("the index folder is made");
        write(
            &index_folder_path.join("segment"),
            b"rows of the damaged file",
        );
        if is_renamed {
            write(&database_path, FRESH_BYTES);
        } else {
            write(&database_path, DAMAGED_BYTES);
            write(
                &sibling_path(&database_path, WRITE_AHEAD_LOG_SUFFIX),
                b"the damaged file's log",
            );
            write(
                &sibling_path(&database_path, FRESH_FILE_SUFFIX),
                FRESH_BYTES,
            );
        }
        record_database_damage(&database_path, "page 7 is damaged")
            .await
            .expect("the damage is recorded");
        write(&sibling_path(&database_path, READY_MARKER_SUFFIX), b"");
        let program = PathBuf::from("/the-shell-is-never-started");
        let shell = SqliteShell::new(
            program.clone(),
            Spawner::new(Handle::current()).expect("the spawner starts"),
        );
        let copier = DatabaseFileCopier::new(
            program,
            Spawner::new(Handle::current()).expect("the spawner starts"),
        );

        let damage = prepare_database_file_repair(&DatabaseFileRepairOptions {
            database_path: &database_path,
            data_folder: data_folder.path(),
            index_folder_path: &index_folder_path,
            shell: &shell,
            copier: &copier,
            schema: &schema_parts().into_schema(),
            now: jiff::Timestamp::now(),
        })
        .await
        .expect("the replacement is finished");

        assert_eq!(damage, None);
        assert_eq!(
            fs::read(&database_path).expect("the database reads"),
            FRESH_BYTES
        );
        for gone in [
            sibling_path(&database_path, WRITE_AHEAD_LOG_SUFFIX),
            sibling_path(&database_path, FRESH_FILE_SUFFIX),
            sibling_path(&database_path, READY_MARKER_SUFFIX),
            index_folder_path,
        ] {
            assert!(!gone.exists(), "{} is left", gone.display());
        }
        assert_eq!(
            read_database_damage(&database_path)
                .await
                .expect("the damage record reads"),
            None
        );
        assert_eq!(
            read_last_run_end(&database_path)
                .await
                .expect("the last run's record reads"),
            LastRunEnd::Clean
        );
    }
}
