//! One backup run, on the service's scheduler: the database copied whole on the writer's own
//! connection into a new backup's folder, checked, flushed and renamed into place, the mirror
//! brought level, the manifest written last, then the write-ahead log truncated and the backups no
//! day or week keeps pruned. A run that fails keeps every backup there is, records why on the
//! service's own session, and leaves the next run to try again. One runner writes a folder at a
//! time, held by an advisory lock on its lock file, which goes with its holder.
//!
//! Runs come from three places: the daily run, while `Back up automatically` is on and something
//! committed since the last copy; the run after a `Delete old data` that removed something, while
//! the switch is on; and `Back up now`, whether it is on or off. A request while a run is queued,
//! or running and not yet copying, joins it, and the run takes the strongest request at each of
//! its checks; one after the copy began queues a run of its own. The run's processor time on its
//! own threads is measured against its budget, under one second per 256 MiB of store, and written
//! to the service log.

mod daily;

use std::error::Error;
use std::fs::{self, File, TryLockError};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
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
use sidekicks_contracts::machine::settings::BackupSettings;
use sidekicks_contracts::release_manifest::ReleaseVersion;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::{FreeFormText, TextError};
use sidekicks_platforms::{
    create_missing_private_folders, create_new_private_folder, flush_file, flush_folder,
    remove_tree, rename_replacing,
};
use tokio_util::sync::CancellationToken;

use crate::daemon::backup::generations::{BackupGeneration, backups_to_prune};
use crate::daemon::machine::settings::file::{MachineSettingsFile, MachineSettingsFileError};
use crate::daemon::release_version::this_build_release_version;
use sidekicks_recovery::database_file::check::SOUND_ROW;
use sidekicks_recovery::database_file::newest_backup::{BackupManifestError, read_backup_manifest};
use sidekicks_std::error_description::describe_error;
use sidekicks_std::file::atomic_write::{AtomicWriteError, write_and_flush};
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::budget::{
    BudgetTerm, JobBudget, JobWorkload, MeteredJobOutcome, ProcessorMeter, WorkUnit, metered_job,
};
use sidekicks_std::scheduler::{JobCondition, ScheduleError, Scheduler};
use sidekicks_std::text_cut::cut_to_code_points;
use sidekicks_store::backup_mirror::{
    MIRROR_FOLDER_NAME, MIRROR_ROOTS_FILE_NAME, MirrorError, MirrorRoot, mirror_roots,
};
use sidekicks_store::data_folder::data_folder;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::wal_truncation::WriteAheadLogTruncation;
use sidekicks_store::database::writer::backup::BackupCopy;
use sidekicks_store::database::writer::{DatabaseWriter, MaintenanceError};
use sidekicks_store::events::log_service::{EventLogAppendOptions, EventLogService};
use sidekicks_store::events::session::appender::{SessionEventDraft, UnsequencedEventEnvelope};
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;
use sidekicks_store::machine::local::LocalMachine;

/// The lock file in the backups folder a run holds while it writes there.
pub(crate) const BACKUP_LOCK_FILE_NAME: &str = "backup.lock";

/// The statements the last run's read prepares, counted into the read pool's capacity.
pub(crate) const BACKUP_STATEMENT_CAPACITY: usize = 1;

/// A run's processor budget, and a repack's, since a `VACUUM` copies the store too: one second
/// per 256 MiB of store.
pub(crate) const BACKUP_BUDGET: JobBudget = JobBudget::new(&[BudgetTerm {
    figure: Duration::from_secs(1),
    per: 256 * 1024 * 1024,
    unit: WorkUnit::StoreBytes,
}]);

// How long a requested run other than `Back up now` waits for no run to be live before it runs
// whatever runs.
const REQUESTED_LATEST_WAIT: Duration = Duration::from_hours(1);

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

/// The backups folder `Back up to` names in `settings`, or the default one in the data folder under
/// `home_folder`; the start reads it before the database file opens, for the repair. Fails when
/// the settings file does not read.
pub(crate) async fn backup_folder(
    settings: &MachineSettingsFile,
    home_folder: &Path,
) -> Result<PathBuf, MachineSettingsFileError> {
    let settings = settings.read().await?.settings.backup;
    Ok(backup_folder_of(&settings, home_folder))
}

// The backups folder `Back up to` names in `backup`, or the default one under `home_folder`.
fn backup_folder_of(backup: &BackupSettings, home_folder: &Path) -> PathBuf {
    backup.folder.as_ref().map_or_else(
        || default_backup_folder(home_folder),
        |folder| PathBuf::from(folder.as_str()),
    )
}

/// The backups folder used when `Back up to` names none: the default one in the data folder under
/// `home_folder`.
pub(crate) fn default_backup_folder(home_folder: &Path) -> PathBuf {
    data_folder(home_folder).join(BACKUP_DEFAULT_FOLDER_NAME)
}

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

/// What each manifest records, from this build's release version, which one release ships as both
/// the app's and the service's, and `machine`'s name, cut to [`BACKUP_LABEL_MAX_LEN`] code points.
/// Fails when the name is blank or holds a NUL.
pub(crate) fn backup_manifest_facts(
    machine: &LocalMachine,
) -> Result<BackupManifestFacts, TextError> {
    let version = this_build_release_version();
    Ok(BackupManifestFacts {
        app_version: version.clone(),
        service_version: version,
        computer_name: FreeFormText::new(
            cut_to_code_points(&machine.name, BACKUP_LABEL_MAX_LEN).to_owned(),
        )?,
    })
}

/// Reads the files and folders the mirror keeps, as they stand at the run, its reads charged to the
/// run's meter.
pub(crate) type MirrorRootsReader =
    Arc<dyn Fn(ProcessorMeter) -> BoxFuture<'static, io::Result<Vec<MirrorRoot>>> + Send + Sync>;

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
    /// The person's home folder, which holds the service's data folder and every place the mirror
    /// keeps.
    pub(crate) home_folder: PathBuf,
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

// One written backup, and the writer thread's commit count at the step that finished its copy,
// every commit up to which it holds.
struct WrittenBackup {
    backup_id: BackupId,
    total_bytes: u64,
    copied_through: u64,
}

// The requests a run takes: until it lets them go, a request joins it by raising `pending`, and it
// lets them go once, as its copy begins, at a check that skips it, or as it ends.
struct JoinedRequests<'backups> {
    pending: &'backups Mutex<Option<BackupTrigger>>,
    is_released: bool,
}

impl JoinedRequests<'_> {
    // Takes the strongest of `trigger` and the requests that joined, and lets them go when
    // `is_skipped` skips the run for it, under one lock, so a request is either seen or queues its
    // own run. Answers whether the run is skipped.
    fn release_if(
        &mut self,
        trigger: BackupTrigger,
        is_skipped: impl FnOnce(BackupTrigger) -> bool,
    ) -> bool {
        let mut pending = lock(self.pending);
        let strongest = pending.map_or(trigger, |joined| joined.max(trigger));
        let is_run_skipped = is_skipped(strongest);
        if is_run_skipped {
            *pending = None;
            self.is_released = true;
        }
        is_run_skipped
    }

    // Lets the requests go, so the next one queues a run of its own.
    fn release(&mut self) {
        if !self.is_released {
            *lock(self.pending) = None;
            self.is_released = true;
        }
    }
}

impl Drop for JoinedRequests<'_> {
    fn drop(&mut self) {
        self.release();
    }
}

/// The service's backups: the runs, the request that joins a queued one, and the daily schedule.
pub(crate) struct Backups {
    deps: BackupDeps,
    // The strongest trigger of the run queued, or running and not yet copying, if any.
    pending: Mutex<Option<BackupTrigger>>,
    // The writer's commit count the last completed copy holds every commit up to.
    committed_at_last_copy: Mutex<Option<u64>>,
}

impl Backups {
    /// The backups over `deps`.
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
        backup_folder(&self.deps.settings, &self.deps.home_folder).await
    }

    /// The service's data folder.
    pub(crate) fn data_folder(&self) -> PathBuf {
        data_folder(&self.deps.home_folder)
    }

    /// Queues a run for `trigger` on `scheduler`, metered against [`BACKUP_BUDGET`], at once for
    /// `Back up now` and otherwise once no run is live, at the latest an hour on; a run already
    /// queued, or running and not yet copying, takes the request instead. Fails when the scheduler
    /// has stopped.
    pub(crate) fn request(
        self: &Arc<Self>,
        scheduler: &Scheduler,
        trigger: BackupTrigger,
    ) -> Result<(), ScheduleError> {
        {
            let mut pending = lock(&self.pending);
            if let Some(queued) = pending.as_mut() {
                *queued = (*queued).max(trigger);
                return Ok(());
            }
            *pending = Some(trigger);
        }
        let condition = match trigger {
            BackupTrigger::Now => JobCondition::Always,
            BackupTrigger::Daily | BackupTrigger::AfterPurge => {
                JobCondition::WhileIdleUntil(SystemTime::now() + REQUESTED_LATEST_WAIT)
            }
        };
        let backups = Arc::clone(self);
        let job = metered_job(
            BACKUP_BUDGET,
            Box::new(move |stop, meter| {
                let backups = Arc::clone(&backups);
                async move { backups.run(trigger, &stop, &meter).await }.boxed()
            }),
        );
        let scheduled = scheduler.schedule("backup", condition, Duration::ZERO, job);
        if scheduled.is_err() {
            *lock(&self.pending) = None;
        }
        scheduled.map(drop)
    }

    /// How the last run ended, `None` before the first. Fails when the log does not read.
    pub(crate) async fn read_last_run(&self) -> Result<Option<BackupLastRun>, BackupLastRunError> {
        self.deps.reads.read(ReadLength::Short, read_last_run).await
    }

    // One run for `trigger`, or a stronger request that joined it, its blocking steps and its copy
    // charged to `meter`: skipped while the switch is off unless it is `Back up now`, and the daily
    // one when nothing committed since the last copy. Requests join it until its copy begins, or
    // until it ends when it never copies. A run that fails records why and keeps every backup; only
    // a failed record fails the job. Answers the store it copied when it wrote a backup.
    async fn run(
        &self,
        trigger: BackupTrigger,
        stop: &CancellationToken,
        meter: &ProcessorMeter,
    ) -> MeteredJobOutcome {
        let mut joined = JoinedRequests {
            pending: &self.pending,
            is_released: false,
        };
        let settings = self.deps.settings.read().await?.settings.backup;
        let commits = self.deps.writer.follow_commits();
        let is_skipped = joined.release_if(trigger, |trigger| {
            if trigger != BackupTrigger::Now && !settings.automatic {
                return true;
            }
            let is_unchanged = trigger == BackupTrigger::Daily
                && *lock(&self.committed_at_last_copy) == Some(*commits.borrow());
            if is_unchanged {
                tracing::info!("the daily backup was skipped: nothing was written since the last");
            }
            is_unchanged
        });
        if is_skipped {
            return Ok(None);
        }
        let folder = backup_folder_of(&settings, &self.deps.home_folder);
        let written = self.write_backup(&folder, stop, meter, &mut joined).await;
        let mut copied = None;
        let event = match written {
            Ok(None) => return Ok(None),
            Ok(Some(written)) => {
                self.deps.truncation.request();
                copied = Some((written.copied_through, written.total_bytes));
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
        self.record(&event).await?;
        let Some((copied_through, total_bytes)) = copied else {
            return Ok(None);
        };
        // The copy holds every commit up to its answer; the record's commit is the one more, so a
        // later commit in between leaves the next daily run to copy it.
        let recorded = *commits.borrow();
        let holds = if recorded == copied_through + 1 {
            recorded
        } else {
            copied_through
        };
        *lock(&self.committed_at_last_copy) = Some(holds);
        Ok(Some(JobWorkload::of(WorkUnit::StoreBytes, total_bytes)))
    }

    // Writes one backup into `folder` under its lock, then prunes the backups no day or week
    // keeps, still under it: `None` when the stop came first, its partial folder removed once the
    // writer's thread has answered, so no step writes into it after. The backup's own folder is
    // owner-only from the moment it exists. The requests `joined` holds are let go as the copy
    // begins, so one after it queues a run of its own.
    async fn write_backup(
        &self,
        folder: &Path,
        stop: &CancellationToken,
        meter: &ProcessorMeter,
        joined: &mut JoinedRequests<'_>,
    ) -> Result<Option<WrittenBackup>, BackupRunError> {
        let locked_folder = folder.to_path_buf();
        let _lock = blocking(meter, move || take_folder_lock(&locked_folder)).await??;
        let id = mint_uuid_v7().to_string();
        let backup_folder = folder.join(&id);
        let staged = backup_folder.join(format!("{BACKUP_DATABASE_FILE_NAME}.tmp"));
        let made_folder = backup_folder.clone();
        blocking(meter, move || {
            create_new_private_folder(&made_folder).map_err(at(&made_folder))
        })
        .await??;
        joined.release();
        let written = self
            .fill_backup(folder, &backup_folder, &staged, id, stop, meter)
            .await;
        if matches!(written, Ok(Some(_))) {
            if let Err(failure) = prune(folder, meter).await {
                tracing::warn!(
                    error = &failure as &(dyn Error + 'static),
                    "the backups no day or week keeps could not all be pruned"
                );
            }
        } else {
            let removed = backup_folder.clone();
            let removal = match blocking(meter, move || remove_tree(&removed)).await {
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

    // Copies, checks and places the database, brings the mirror level and writes the manifest. The
    // copy is never dropped while the writer's thread steps it: the stop cancels it, and the
    // thread answers before its next step.
    async fn fill_backup(
        &self,
        folder: &Path,
        backup_folder: &Path,
        staged: &Path,
        id: String,
        stop: &CancellationToken,
        meter: &ProcessorMeter,
    ) -> Result<Option<WrittenBackup>, BackupRunError> {
        let copy = self
            .deps
            .writer
            .backup(staged.to_path_buf(), stop.clone())
            .await
            .map_err(BackupRunError::Copy)?;
        meter.add(copy.processor_time);
        let copied_through = match copy.report {
            BackupCopy::Copied { copied_through, .. } => copied_through,
            BackupCopy::HeldByLock(lock) => {
                return Err(BackupRunError::HeldByLock(lock.describe()));
            }
            BackupCopy::Stopped => return Ok(None),
        };
        let checked = staged.to_path_buf();
        let database = backup_folder.join(BACKUP_DATABASE_FILE_NAME);
        let placed = database.clone();
        let total_bytes = blocking(meter, move || check_and_place(&checked, &placed)).await??;
        let roots = (self.deps.read_mirror_roots)(meter.clone())
            .await
            .map_err(BackupRunError::MirrorRoots)?;
        let mirror_folder = folder.join(MIRROR_FOLDER_NAME);
        let mirrored_folder = mirror_folder.clone();
        let mirrored_roots = roots.clone();
        let home = self.deps.home_folder.clone();
        let mirror_stop = stop.clone();
        let mirrored = blocking(meter, move || {
            mirror_roots(&mirrored_folder, &home, &mirrored_roots, &mirror_stop)
        })
        .await?;
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
        let roots_file = mirror_folder.join(MIRROR_ROOTS_FILE_NAME);
        blocking(meter, move || {
            write_and_flush(&roots_file, &roots_list, BACKUP_FILE_MODE)
        })
        .await??;
        let backup_id = BackupId::new(id).expect("a minted id is text within a backup id's cap");
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
        let manifest_file = backup_folder.join(BACKUP_MANIFEST_FILE_NAME);
        blocking(meter, move || {
            write_and_flush(&manifest_file, &manifest_bytes, BACKUP_FILE_MODE)
        })
        .await??;
        let flushed = folder.to_path_buf();
        blocking(meter, move || flush_folder(&flushed).map_err(at(&flushed))).await??;
        Ok(Some(WrittenBackup {
            backup_id,
            total_bytes,
            copied_through,
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

/// The backups in `folder` whose manifest reads, with when each was taken, read on the calling
/// thread; a folder without one is no backup and is passed over. Fails when the folder or a
/// manifest's file does not read.
pub(crate) fn read_backups(folder: &Path) -> io::Result<Vec<(PathBuf, BackupManifest)>> {
    let mut backups = Vec::new();
    let entries = match fs::read_dir(folder) {
        Ok(entries) => entries,
        Err(failure) if failure.kind() == io::ErrorKind::NotFound => return Ok(backups),
        Err(failure) => return Err(failure),
    };
    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        match read_backup_manifest(&entry.path()) {
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

// Removes the backups in `folder` that no day or week keeps, and each folder a run a crash cut
// short left without its manifest: only one named as a run names its backup, so no folder of the
// person's own goes.
async fn prune(folder: &Path, meter: &ProcessorMeter) -> io::Result<()> {
    let listed = folder.to_path_buf();
    meter
        .run_blocking(move || {
            let generations: Vec<BackupGeneration> = read_backups(&listed)?
                .into_iter()
                .filter_map(|(folder, manifest)| {
                    let taken_at = manifest.taken_at.as_str().parse::<jiff::Timestamp>().ok()?;
                    Some(BackupGeneration { folder, taken_at })
                })
                .collect();
            let mut pruned = backups_to_prune(&generations, &jiff::tz::TimeZone::system());
            pruned.extend(read_unfinished_backups(&listed)?);
            for folder in &pruned {
                remove_tree(folder)?;
            }
            Ok(())
        })
        .await
        .map_err(io::Error::other)?
}

// The folders in `folder` named as a run names a backup that hold no manifest.
fn read_unfinished_backups(folder: &Path) -> io::Result<Vec<PathBuf>> {
    let mut unfinished = Vec::new();
    for entry in fs::read_dir(folder)? {
        let entry = entry?;
        let is_backup_name = entry
            .file_name()
            .to_str()
            .is_some_and(|name| uuid::Uuid::try_parse(name).is_ok());
        if is_backup_name
            && entry.file_type()?.is_dir()
            && !fs::exists(entry.path().join(BACKUP_MANIFEST_FILE_NAME))?
        {
            unfinished.push(entry.path());
        }
    }
    Ok(unfinished)
}

// Takes the backups folder's lock, making each missing folder on its way owner-only first and
// leaving one that exists as it is; the lock goes when the file drops.
fn take_folder_lock(folder: &Path) -> Result<File, BackupRunError> {
    create_missing_private_folders(folder).map_err(at(folder))?;
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
    let finished_at =
        sidekicks_store::database::stored_column::text_column(row, 1, WireInstant::try_from)?;
    if event_type == SessionEventType::DaemonBackupCompleted.as_str() {
        return Ok(Some(BackupLastRun::Completed { finished_at }));
    }
    let payload: DaemonBackupFailedPayload =
        sidekicks_store::database::stored_column::text_column(row, 2, |text| {
            serde_json::from_str(&text)
        })?;
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

// Runs `work` on the blocking pool, charged to `meter`.
async fn blocking<Answer: Send + 'static>(
    meter: &ProcessorMeter,
    work: impl FnOnce() -> Answer + Send + 'static,
) -> Result<Answer, BackupRunError> {
    meter
        .run_blocking(work)
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
