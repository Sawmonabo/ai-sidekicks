//! One backup run, on the service's scheduler: the database copied whole on the writer's own
//! connection into a new backup's folder, checked, flushed and renamed into place, the mirror
//! brought level, the manifest written last, then the write-ahead log truncated and the backups no
//! day or week keeps pruned. A run that fails keeps every backup there is, records why on the
//! service's own session, and leaves the next run to try again. One runner writes a folder at a
//! time, held by an advisory lock on its lock file, which goes with its holder.
//!
//! Runs come from three places: the daily run, while `Back up automatically` is on and something
//! committed since the last copy; the run after a `Delete old data` that removed something, while
//! the switch is on; and `Back up now`, whether it is on or off. A request while a run is queued
//! or running joins it. The run's processor time is measured against its budget, under one second
//! per 256 MiB of store, and written to the service log.

use std::error::Error;
use std::fs::{self, File, TryLockError};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError, Weak};
use std::time::{Duration, SystemTime};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rusqlite::Connection;
use sidekicks_contracts::daemon::backup::{
    BACKUP_DATABASE_FILE_NAME, BACKUP_DEFAULT_FOLDER_NAME, BACKUP_LABEL_MAX_LEN,
    BACKUP_MANIFEST_FILE_NAME, BackupId, BackupLastRun, BackupManifest,
    DaemonBackupCompletedPayload, DaemonBackupFailedPayload,
};
use sidekicks_contracts::error::ERROR_MESSAGE_MAX_LEN;
use sidekicks_contracts::event::envelope::{DAEMON_SCOPE_SENTINEL_SESSION_ID, EventOccurredAt};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::release_manifest::ReleaseVersion;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_platforms::{
    create_private_folder, flush_file, flush_folder, remove_tree, rename_replacing,
};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tokio_util::sync::CancellationToken;

use crate::daemon::backup::generations::{BackupGeneration, backups_to_prune};
use crate::daemon::backup::mirror::{
    MIRROR_FOLDER_NAME, MIRROR_ROOTS_FILE_NAME, MirrorError, MirrorRoot, mirror_roots,
};
use crate::daemon::machine::settings::file::{MachineSettingsFile, MachineSettingsFileError};
use crate::daemon::scheduler::{JobCondition, ScheduleError, ScheduledJobOutcome, Scheduler};
use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::database::writer::backup::BackupCopy;
use crate::database::writer::{DatabaseWriter, MaintenanceError};
use crate::error_description::describe_error;
use crate::events::log_service::{EventLogAppendOptions, EventLogService};
use crate::events::session::appender::{SessionEventDraft, UnsequencedEventEnvelope};
use crate::events::session::purge::checkpoint::WriteAheadLogTruncation;
use crate::events::session::version::SESSION_EVENT_VERSION;
use crate::file::atomic_write::{AtomicWriteError, write_file_atomically};
use crate::recovery::database_file::check::SOUND_ROW;
use crate::recovery::database_file::newest_backup::{BackupManifestError, read_backup_manifest};
use crate::text_cut::cut_to_code_points;

/// The lock file in the backups folder a run holds while it writes there.
pub(crate) const BACKUP_LOCK_FILE_NAME: &str = "backup.lock";

/// The statements the last run's read prepares, counted into the read pool's capacity.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the daemon's start, sizing its read connections")
)]
pub(crate) const BACKUP_STATEMENT_CAPACITY: usize = 1;

// How long after the last run the daily run falls due, and how long past that it waits for no
// run to be live before it runs whatever runs.
const DAILY_INTERVAL: Duration = Duration::from_hours(24);
const DAILY_LATEST_WAIT: Duration = Duration::from_hours(1);

// The store a run may copy per second of processor time.
const STORE_BYTES_PER_PROCESSOR_SECOND: u64 = 256 * 1024 * 1024;

// A file holding a new backup's own files, owner-only.
const BACKUP_FILE_MODE: u32 = 0o600;

static LAST_RUN_SQL: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    format!(
        "SELECT type, occurred_at, payload FROM session_events
         WHERE session_id = ?1 AND type IN ('{}', '{}')
         ORDER BY sequence DESC LIMIT 1",
        SessionEventType::DaemonBackupCompleted.as_str(),
        SessionEventType::DaemonBackupFailed.as_str(),
    )
});

/// What asked for a run, weakest first: a request joining a queued run keeps the stronger.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum BackupTrigger {
    /// The daily run.
    Daily,
    /// The run after a `Delete old data` that removed something.
    AfterPurge,
    /// `Back up now`.
    Now,
}

/// What each manifest records about the service that wrote it.
pub(crate) struct BackupManifestFacts {
    /// The app's version.
    pub(crate) app_version: ReleaseVersion,
    /// The service's version.
    pub(crate) service_version: ReleaseVersion,
    /// The computer's name.
    pub(crate) computer_name: FreeFormText<BACKUP_LABEL_MAX_LEN>,
}

/// Reads the files and folders the mirror keeps, as they stand at the run.
pub(crate) type MirrorRootsReader =
    Arc<dyn Fn() -> BoxFuture<'static, io::Result<Vec<MirrorRoot>>> + Send + Sync>;

/// What the runs read and write through.
pub(crate) struct BackupDeps {
    /// The writer whose connection copies the database.
    pub(crate) writer: Arc<DatabaseWriter>,
    /// The log the runs' events land in, on the service's own session.
    pub(crate) event_log: Arc<EventLogService>,
    /// The read pool the last run is read through.
    pub(crate) reads: Arc<DatabaseReadPool>,
    /// The write-ahead log's truncation, run once a copy completes.
    pub(crate) truncation: Arc<WriteAheadLogTruncation>,
    /// The settings file holding `Back up automatically` and `Back up to`.
    pub(crate) settings: Arc<MachineSettingsFile>,
    /// The service's data folder, which holds the default backups folder.
    pub(crate) data_folder: PathBuf,
    /// The files and folders the mirror keeps.
    pub(crate) read_mirror_roots: MirrorRootsReader,
    /// What each manifest records.
    pub(crate) manifest_facts: BackupManifestFacts,
}

/// Why a run did not write a backup.
#[derive(Debug, thiserror::Error)]
pub(crate) enum BackupRunError {
    /// The settings file did not read.
    #[error("the backup settings could not be read")]
    Settings(#[from] MachineSettingsFileError),
    /// The backups folder or a backup's file could not be made, written or removed.
    #[error("the backups folder could not be written at {}", path.display())]
    Folder {
        /// Where.
        path: PathBuf,
        /// The system's failure.
        #[source]
        source: io::Error,
    },
    /// Another service holds the backups folder's lock.
    #[error("another service is writing backups to {}", folder.display())]
    FolderHeld {
        /// The backups folder.
        folder: PathBuf,
    },
    /// The writer refused or failed the copy.
    #[error("the database could not be copied")]
    Copy(#[source] MaintenanceError),
    /// The copy's steps met a lock for ten minutes running.
    #[error("the copy stopped: {0}")]
    HeldByLock(&'static str),
    /// The copy is damaged, as SQLite's check reported it.
    #[error("the database's copy failed its check: {0}")]
    Damaged(String),
    /// SQLite failed the copy's check.
    #[error("the database's copy could not be checked")]
    Check(#[source] rusqlite::Error),
    /// The mirror's files did not read.
    #[error("the files kept beside the database could not be listed")]
    MirrorRoots(#[source] io::Error),
    /// The mirror did not finish.
    #[error(transparent)]
    Mirror(#[from] MirrorError),
    /// A manifest or the mirror's list did not write.
    #[error(transparent)]
    Write(#[from] AtomicWriteError),
    /// The list of the mirror's roots did not serialize.
    #[error("the mirror's list could not be written")]
    MirrorList(#[source] serde_json::Error),
    /// A blocking step ended before it finished.
    #[error("a step of the backup ended before it finished")]
    Interrupted(#[source] tokio::task::JoinError),
}

/// Why the last run could not be read.
#[derive(Debug, thiserror::Error)]
pub(crate) enum BackupLastRunError {
    /// SQLite failed the read, or a row did not read as a run's event.
    #[error("the last backup run could not be read")]
    Read(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read did not finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
}

// One written backup.
struct WrittenBackup {
    backup_id: BackupId,
    total_bytes: u64,
}

/// The service's backups: the runs, the request that joins a queued one, and the daily schedule.
pub(crate) struct Backups {
    deps: BackupDeps,
    // The strongest trigger of the run queued or running, if any.
    pending: Mutex<Option<BackupTrigger>>,
    // The writer's commit count the last completed copy holds every commit up to.
    committed_at_last_copy: Mutex<Option<u64>>,
}

impl Backups {
    /// The backups over `deps`.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the daemon's start makes the service's backups")
    )]
    pub(crate) fn new(deps: BackupDeps) -> Arc<Self> {
        Arc::new(Self {
            deps,
            pending: Mutex::new(None),
            committed_at_last_copy: Mutex::new(None),
        })
    }

    /// The backups folder `Back up to` names, or the default one in the data folder. Fails when
    /// the settings file does not read.
    pub(crate) async fn folder(&self) -> Result<PathBuf, MachineSettingsFileError> {
        let settings = self.deps.settings.read().await?.settings.backup;
        Ok(settings.folder.map_or_else(
            || self.deps.data_folder.join(BACKUP_DEFAULT_FOLDER_NAME),
            |folder| PathBuf::from(folder.as_str()),
        ))
    }

    /// The service's data folder.
    pub(crate) fn data_folder(&self) -> &Path {
        &self.deps.data_folder
    }

    /// Queues a run for `trigger` on `scheduler`, at once for `Back up now` and otherwise once no
    /// run is live, at the latest an hour on; a run already queued or running takes the request
    /// instead. Fails when the scheduler has stopped.
    pub(crate) fn request(
        self: &Arc<Self>,
        scheduler: &Scheduler,
        trigger: BackupTrigger,
    ) -> Result<(), ScheduleError> {
        {
            let mut pending = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some(queued) = pending.as_mut() {
                *queued = (*queued).max(trigger);
                return Ok(());
            }
            *pending = Some(trigger);
        }
        let condition = match trigger {
            BackupTrigger::Now => JobCondition::Always,
            BackupTrigger::Daily | BackupTrigger::AfterPurge => {
                JobCondition::NoTurnRunningUntil(DAILY_LATEST_WAIT)
            }
        };
        let backups = Arc::clone(self);
        let scheduled = scheduler.schedule("backup", condition, Duration::ZERO, move |stop| {
            let backups = Arc::clone(&backups);
            async move {
                let trigger = backups
                    .pending
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .unwrap_or(trigger);
                let ran = backups.run(trigger, &stop).await;
                *backups
                    .pending
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner) = None;
                ran
            }
            .boxed()
        });
        if scheduled.is_err() {
            *self.pending.lock().unwrap_or_else(PoisonError::into_inner) = None;
        }
        scheduled.map(drop)
    }

    /// Schedules the daily run a day after the last run ended, or at once before the first, on
    /// the wall clock so sleep does not hold it back; each daily run schedules the next. Fails
    /// when the last run does not read or the scheduler refuses the run.
    #[expect(dead_code, reason = "the daemon's start schedules the daily backup")]
    pub(crate) async fn schedule_daily(
        self: &Arc<Self>,
        scheduler: &Arc<Scheduler>,
    ) -> Result<(), Box<dyn Error + Send + Sync>> {
        let last_finished = self
            .read_last_run()
            .await?
            .and_then(|last_run| last_finished_at(&last_run));
        let due = last_finished.map_or_else(SystemTime::now, |finished| finished + DAILY_INTERVAL);
        schedule_daily_at(Arc::clone(self), Arc::downgrade(scheduler), scheduler, due)?;
        Ok(())
    }

    /// How the last run ended, `None` before the first. Fails when the log does not read.
    pub(crate) async fn read_last_run(&self) -> Result<Option<BackupLastRun>, BackupLastRunError> {
        self.deps.reads.read(ReadLength::Short, read_last_run).await
    }

    // One run for `trigger`: skipped while the switch is off unless it is `Back up now`, and the
    // daily one when nothing committed since the last copy. A run that fails records why and
    // keeps every backup; only a failed record fails the job.
    async fn run(&self, trigger: BackupTrigger, stop: &CancellationToken) -> ScheduledJobOutcome {
        let settings = self.deps.settings.read().await?.settings.backup;
        if trigger != BackupTrigger::Now && !settings.automatic {
            return Ok(());
        }
        let commits = self.deps.writer.follow_commits();
        let committed = *commits.borrow();
        if trigger == BackupTrigger::Daily
            && *self
                .committed_at_last_copy
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                == Some(committed)
        {
            tracing::info!("the daily backup was skipped: nothing was written since the last");
            return Ok(());
        }
        let folder = self.folder().await?;
        let processor_before = read_own_processor_time().await;
        let written = self.write_backup(&folder, stop).await;
        let copied_through = *commits.borrow();
        let event = match written {
            Ok(None) => return Ok(()),
            Ok(Some(written)) => {
                self.deps.truncation.request();
                if let Err(failure) = prune(&folder).await {
                    tracing::warn!(
                        error = &failure as &(dyn Error + 'static),
                        "the backups no day or week keeps could not all be pruned"
                    );
                }
                log_processor_time(processor_before, written.total_bytes).await;
                SessionEvent::DaemonBackupCompleted(DaemonBackupCompletedPayload {
                    backup_id: written.backup_id,
                    total_bytes: SafeInt::new(written.total_bytes)
                        .expect("a backup's size is a safe integer"),
                })
            }
            Err(failure) => {
                tracing::warn!(
                    error = &failure as &(dyn Error + 'static),
                    "the backup did not finish; the next run tries again"
                );
                let message = describe_error(&failure);
                SessionEvent::DaemonBackupFailed(DaemonBackupFailedPayload {
                    message: FreeFormText::new(
                        cut_to_code_points(&message, ERROR_MESSAGE_MAX_LEN).to_owned(),
                    )
                    .expect("a failure's description is text without NUL"),
                })
            }
        };
        let is_completed = matches!(event, SessionEvent::DaemonBackupCompleted(_));
        self.record(&event).await?;
        if is_completed {
            // The copy holds every commit up to its own end; the record's commit is the one more,
            // so a later commit in between leaves the next daily run to copy it.
            let recorded = *commits.borrow();
            let holds = if recorded == copied_through + 1 {
                recorded
            } else {
                copied_through
            };
            *self
                .committed_at_last_copy
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = Some(holds);
        }
        Ok(())
    }

    // Writes one backup into `folder` under its lock: `None` when the stop came first, its
    // partial folder removed.
    async fn write_backup(
        &self,
        folder: &Path,
        stop: &CancellationToken,
    ) -> Result<Option<WrittenBackup>, BackupRunError> {
        let locked_folder = folder.to_path_buf();
        let _lock = blocking(move || take_folder_lock(&locked_folder)).await??;
        let id = mint_uuid_v7().to_string();
        let backup_folder = folder.join(&id);
        let staged = backup_folder.join(format!("{BACKUP_DATABASE_FILE_NAME}.tmp"));
        let made_folder = backup_folder.clone();
        blocking(move || fs::create_dir(&made_folder).map_err(at(&made_folder))).await??;
        let written = self
            .fill_backup(folder, &backup_folder, &staged, id, stop)
            .await;
        if !matches!(written, Ok(Some(_))) {
            let removed = backup_folder.clone();
            let removal = match blocking(move || remove_tree(&removed)).await {
                Ok(removal) => removal.map_err(at(&backup_folder)),
                Err(interrupted) => Err(interrupted),
            };
            if let Err(failure) = removal {
                tracing::warn!(
                    error = &failure as &(dyn Error + 'static),
                    "the unfinished backup's folder could not be removed"
                );
            }
        }
        written
    }

    // Copies, checks and places the database, brings the mirror level and writes the manifest.
    async fn fill_backup(
        &self,
        folder: &Path,
        backup_folder: &Path,
        staged: &Path,
        id: String,
        stop: &CancellationToken,
    ) -> Result<Option<WrittenBackup>, BackupRunError> {
        let copy = tokio::select! {
            biased;
            () = stop.cancelled() => return Ok(None),
            copy = self.deps.writer.backup(staged.to_path_buf()) => copy,
        };
        match copy.map_err(BackupRunError::Copy)? {
            BackupCopy::Copied { .. } => {}
            BackupCopy::HeldByLock(lock) => {
                return Err(BackupRunError::HeldByLock(lock.describe()));
            }
            BackupCopy::Stopped => return Ok(None),
        }
        let checked = staged.to_path_buf();
        let database = backup_folder.join(BACKUP_DATABASE_FILE_NAME);
        let placed = database.clone();
        let total_bytes = blocking(move || check_and_place(&checked, &placed)).await??;
        let roots = (self.deps.read_mirror_roots)()
            .await
            .map_err(BackupRunError::MirrorRoots)?;
        let mirror_folder = folder.join(MIRROR_FOLDER_NAME);
        let mirrored_folder = mirror_folder.clone();
        let mirrored_roots = roots.clone();
        let mirror_stop = stop.clone();
        let mirrored =
            blocking(move || mirror_roots(&mirrored_folder, &mirrored_roots, &mirror_stop)).await?;
        let report = match mirrored {
            Ok(report) => report,
            Err(MirrorError::Stopped) => return Ok(None),
            Err(failure) => return Err(failure.into()),
        };
        tracing::info!(
            copied_files = report.copied_files,
            copied_bytes = report.copied_bytes,
            removed_entries = report.removed_entries,
            "the backup's mirror was brought level"
        );
        let roots_list = serde_json::to_vec(&roots).map_err(BackupRunError::MirrorList)?;
        write_file_atomically(
            &mirror_folder.join(MIRROR_ROOTS_FILE_NAME),
            roots_list,
            BACKUP_FILE_MODE,
        )
        .await?;
        let backup_id = BackupId::new(
            FreeFormText::new(id).expect("a minted id is text within a backup id's cap"),
        );
        let facts = &self.deps.manifest_facts;
        let manifest = BackupManifest {
            backup_id: backup_id.clone(),
            taken_at: WireInstant::now(),
            app_version: facts.app_version.clone(),
            service_version: facts.service_version.clone(),
            total_bytes: SafeInt::new(total_bytes).expect("a backup's size is a safe integer"),
            computer_name: facts.computer_name.clone(),
            distribution_parts: None,
        };
        let manifest_bytes = serde_json::to_vec(&manifest).expect("a manifest serializes as JSON");
        write_file_atomically(
            &backup_folder.join(BACKUP_MANIFEST_FILE_NAME),
            manifest_bytes,
            BACKUP_FILE_MODE,
        )
        .await?;
        let flushed = folder.to_path_buf();
        blocking(move || flush_folder(&flushed).map_err(at(&flushed))).await??;
        Ok(Some(WrittenBackup {
            backup_id,
            total_bytes,
        }))
    }

    // Appends `event` on the service's own session.
    async fn record(&self, event: &SessionEvent) -> Result<(), Box<dyn Error + Send + Sync>> {
        let draft = SessionEventDraft::of_session(*DAEMON_SCOPE_SENTINEL_SESSION_ID, event)?;
        let envelope = UnsequencedEventEnvelope::new(
            draft,
            EventOccurredAt::now(),
            None,
            None,
            SESSION_EVENT_VERSION.clone(),
        );
        self.deps
            .event_log
            .append(envelope, EventLogAppendOptions::default())
            .await?;
        Ok(())
    }
}

// Schedules the daily run at `due`; the run schedules the next a day after it ends.
fn schedule_daily_at(
    backups: Arc<Backups>,
    scheduler_handle: Weak<Scheduler>,
    scheduler: &Scheduler,
    due: SystemTime,
) -> Result<(), ScheduleError> {
    scheduler
        .schedule_at(
            "daily backup",
            JobCondition::NoTurnRunningUntil(DAILY_LATEST_WAIT),
            due,
            move |stop| {
                let backups = Arc::clone(&backups);
                let scheduler_handle = scheduler_handle.clone();
                async move {
                    // A run queued or running copies for this one.
                    let is_queued = backups
                        .pending
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .is_some();
                    let ran = if is_queued {
                        Ok(())
                    } else {
                        backups.run(BackupTrigger::Daily, &stop).await
                    };
                    if let Some(scheduler) = scheduler_handle.upgrade() {
                        let next = SystemTime::now() + DAILY_INTERVAL;
                        schedule_daily_at(
                            Arc::clone(&backups),
                            scheduler_handle,
                            &scheduler,
                            next,
                        )?;
                    }
                    ran
                }
                .boxed()
            },
        )
        .map(drop)
}

/// The backups in `folder` whose manifest reads, with when each was taken; a folder without one
/// is no backup and is passed over. Fails when the folder or a manifest's file does not read.
pub(crate) async fn read_backups(folder: &Path) -> io::Result<Vec<(PathBuf, BackupManifest)>> {
    let mut backups = Vec::new();
    let mut entries = match tokio::fs::read_dir(folder).await {
        Ok(entries) => entries,
        Err(failure) if failure.kind() == io::ErrorKind::NotFound => return Ok(backups),
        Err(failure) => return Err(failure),
    };
    while let Some(entry) = entries.next_entry().await? {
        if !entry.file_type().await?.is_dir() {
            continue;
        }
        match read_backup_manifest(&entry.path()).await {
            Ok(Some(manifest)) => backups.push((entry.path(), manifest)),
            Ok(None) => {}
            Err(BackupManifestError::Read(failure)) => return Err(failure),
            Err(error @ (BackupManifestError::Parse(_) | BackupManifestError::Check(_))) => {
                tracing::warn!(
                    backup = %entry.path().display(),
                    error = &error as &(dyn Error + 'static),
                    "the backup's manifest does not read and the backup is passed over"
                );
            }
        }
    }
    Ok(backups)
}

// Removes the backups in `folder` that no day or week keeps.
async fn prune(folder: &Path) -> io::Result<()> {
    let generations: Vec<BackupGeneration> = read_backups(folder)
        .await?
        .into_iter()
        .filter_map(|(folder, manifest)| {
            let taken_at = manifest.taken_at.as_str().parse::<jiff::Timestamp>().ok()?;
            Some(BackupGeneration { folder, taken_at })
        })
        .collect();
    let pruned = backups_to_prune(&generations, &jiff::tz::TimeZone::system());
    tokio::task::spawn_blocking(move || {
        for folder in &pruned {
            remove_tree(folder)?;
        }
        Ok(())
    })
    .await
    .map_err(io::Error::other)?
}

// Takes the backups folder's lock, making the folder owner-only first; the lock goes when the
// file drops.
fn take_folder_lock(folder: &Path) -> Result<File, BackupRunError> {
    create_private_folder(folder).map_err(at(folder))?;
    let lock_path = folder.join(BACKUP_LOCK_FILE_NAME);
    let file = File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(at(&lock_path))?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(TryLockError::WouldBlock) => Err(BackupRunError::FolderHeld {
            folder: folder.to_path_buf(),
        }),
        Err(TryLockError::Error(failure)) => Err(at(&lock_path)(failure)),
    }
}

// Checks the staged copy whole, flushes it, renames it to `database` and flushes its folder;
// answers its size.
fn check_and_place(staged: &Path, database: &Path) -> Result<u64, BackupRunError> {
    // Opened for writing: the copy keeps the source's write-ahead-log mark, and a read-only open of
    // such a file finds no log to read; the close removes the log it made.
    let connection = Connection::open(staged).map_err(BackupRunError::Check)?;
    let rows = read_integrity_check(&connection).map_err(BackupRunError::Check)?;
    connection
        .close()
        .map_err(|(_connection, failure)| BackupRunError::Check(failure))?;
    if rows != [SOUND_ROW] {
        return Err(BackupRunError::Damaged(rows.join("; ")));
    }
    flush_file(staged).map_err(at(staged))?;
    rename_replacing(staged, database).map_err(at(database))?;
    let folder = database
        .parent()
        .expect("a backup's copy sits in its folder");
    flush_folder(folder).map_err(at(folder))?;
    Ok(fs::metadata(database).map_err(at(database))?.len())
}

fn read_integrity_check(connection: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut statement = connection.prepare("PRAGMA integrity_check")?;
    statement.query_map([], |row| row.get(0))?.collect()
}

fn read_last_run(connection: &Connection) -> Result<Option<BackupLastRun>, BackupLastRunError> {
    let mut statement = connection.prepare_cached(&LAST_RUN_SQL)?;
    let mut rows = statement.query([DAEMON_SCOPE_SENTINEL_SESSION_ID.text().as_str()])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    let event_type: String = row.get(0)?;
    let finished_at = crate::database::stored_column::text_column(row, 1, WireInstant::try_from)?;
    if event_type == SessionEventType::DaemonBackupCompleted.as_str() {
        return Ok(Some(BackupLastRun::Completed { finished_at }));
    }
    let payload: DaemonBackupFailedPayload =
        crate::database::stored_column::text_column(row, 2, |text| serde_json::from_str(&text))?;
    Ok(Some(BackupLastRun::Failed {
        finished_at,
        message: payload.message,
    }))
}

// When `last_run` ended, on the wall clock.
fn last_finished_at(last_run: &BackupLastRun) -> Option<SystemTime> {
    let (BackupLastRun::Completed { finished_at } | BackupLastRun::Failed { finished_at, .. }) =
        last_run;
    let finished: jiff::Timestamp = finished_at.as_str().parse().ok()?;
    Some(SystemTime::from(finished))
}

// The service's own processor time so far.
async fn read_own_processor_time() -> Duration {
    tokio::task::spawn_blocking(|| {
        let pid = Pid::from_u32(std::process::id());
        let mut system = System::new();
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            true,
            ProcessRefreshKind::nothing().without_tasks().with_cpu(),
        );
        system.process(pid).map_or(Duration::ZERO, |process| {
            Duration::from_millis(process.accumulated_cpu_time())
        })
    })
    .await
    .unwrap_or_default()
}

// Writes the run's processor time beside its budget for a store of `store_bytes`.
async fn log_processor_time(before: Duration, store_bytes: u64) {
    let spent = read_own_processor_time().await.saturating_sub(before);
    #[expect(
        clippy::cast_precision_loss,
        reason = "a budget in seconds needs no more than a double's precision"
    )]
    let budget =
        Duration::from_secs_f64(store_bytes as f64 / STORE_BYTES_PER_PROCESSOR_SECOND as f64);
    if spent > budget {
        tracing::warn!(
            spent_ms = spent.as_millis(),
            budget_ms = budget.as_millis(),
            store_bytes,
            "the backup took more processor time than its budget"
        );
    } else {
        tracing::info!(
            spent_ms = spent.as_millis(),
            budget_ms = budget.as_millis(),
            store_bytes,
            "the backup's processor time"
        );
    }
}

// Runs `work` on the blocking pool.
async fn blocking<Answer: Send + 'static>(
    work: impl FnOnce() -> Answer + Send + 'static,
) -> Result<Answer, BackupRunError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(BackupRunError::Interrupted)
}

// The failure at `path`.
fn at(path: &Path) -> impl FnOnce(io::Error) -> BackupRunError + use<> {
    let path = path.to_path_buf();
    move |source| BackupRunError::Folder { path, source }
}

#[cfg(test)]
pub(crate) mod tests;
