//! The repository services the daemon's start builds once on its git: the repository mounts, the
//! chats' managed workspaces, the broker git's questions reach the person through, the watch over
//! each working folder, the live sessions' folders and their projects' fetches, the branch lists,
//! the worktrees, the turn snapshots and the mounts' health re-probe. Their background work begins
//! once the start's recovery pass has settled the runs. Here too are the worktrees folder the start
//! makes once, and the record of the instant the chats' write watch walks from at a start.

use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::machine::id::MachineId;
use sidekicks_platforms::{askpass_socket_path, inotify_watch_ceiling};
use sidekicks_session::directory::list_feed::SessionListFeed;
use sidekicks_session::live_folders::{
    LiveFolderError, LiveSessionFolders, LiveSessionFoldersDeps,
};
use sidekicks_session::review_note::store::SessionReviewNoteStore;
use sidekicks_std::error_description::describe_error;
use sidekicks_std::file::atomic_write::write_file_atomically;
use sidekicks_std::file::real_location::resolve_real_path;
use sidekicks_std::missing_entry::MissingEntry as _;
use sidekicks_std::scheduler::{
    JobCondition, ScheduleError, ScheduledJobHandle, Scheduler, WakeSignal,
};
use sidekicks_store::data_folder::data_folder;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::DatabaseWriter;
use sidekicks_store::events::log_service::EventLogService;
use sidekicks_store::events::session::followers::SessionEventFollowers;
use sidekicks_workspace::clone::askpass::broker::{AskpassBroker, AskpassBrokerError};
use sidekicks_workspace::clone::askpass::program::git_askpass_program_path;
use sidekicks_workspace::event_emitter::WorkspaceEventEmitter;
use sidekicks_workspace::git::process::GitRunner;
use sidekicks_workspace::git::turn_snapshot::service::TurnSnapshotService;
use sidekicks_workspace::git::worktree::branch_list::BranchListReader;
use sidekicks_workspace::git::worktree::event_emitter::WorktreeEventEmitter;
use sidekicks_workspace::git::worktree::fetch::{BackgroundFetch, BackgroundFetchDeps};
use sidekicks_workspace::git::worktree::naming::worktrees_folder;
use sidekicks_workspace::git::worktree::occupancy::MountOccupancyReader;
use sidekicks_workspace::git::worktree::service::{WorktreeService, WorktreeServiceDeps};
use sidekicks_workspace::git::worktree::watch::{
    SLOW_TICK_INTERVAL, WorkingFolderWatcher, WorkingFolderWatcherDeps,
};
use sidekicks_workspace::managed::service::ManagedWorkspaceService;
use sidekicks_workspace::managed::write_watcher::{ManagedWorkspaceReport, ManagedWritesWatermark};
use sidekicks_workspace::repo::mount::health::{RepoMountHealthReprobe, ReprobeError};
use sidekicks_workspace::repo::mount::service::RepoMountService;
use sidekicks_workspace::repo::root_resolver::RepoRootResolver;
use tokio::sync::{Notify, broadcast, mpsc};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::daemon::already_running_error::{DaemonAlreadyRunningError, HeldPlace};
use crate::daemon::process::stop::TaskStopFailure;

// The chats' writes the watch may report ahead of their recording; a full channel holds the watch
// until the versions catch up.
const MANAGED_WORKSPACE_WRITE_CAPACITY: usize = 64;

// The record, in the data folder, of the instant the chats' write watch walks from at a start.
const MANAGED_WRITES_WATERMARK_FILE_NAME: &str = "managed-workspace-writes-since";

// The record is the person's alone.
const MANAGED_WRITES_WATERMARK_MODE: u32 = 0o600;

/// What the repository services are built from.
pub(crate) struct RepoServiceStart {
    /// The person's home, which holds the chats' managed workspaces.
    pub(crate) home_folder: PathBuf,
    /// The run folder, private to this account, where the askpass broker's socket goes.
    pub(crate) run_folder: PathBuf,
    /// The daemon's own program, which git's askpass program sits beside.
    pub(crate) daemon_program: PathBuf,
    /// The daemon's one git, whose failed calls' trees the stop waits for.
    pub(crate) git: GitRunner,
    /// The daemon's one read pool.
    pub(crate) reads: Arc<DatabaseReadPool>,
    /// The daemon's one writer.
    pub(crate) writer: Arc<DatabaseWriter>,
    /// The daemon's one event log.
    pub(crate) event_log: Arc<EventLogService>,
    /// This machine, whose mounts the service keeps.
    pub(crate) machine_id: MachineId,
    /// The daemon's one scheduler, which runs each working folder's slow tick.
    pub(crate) scheduler: Arc<Scheduler>,
    /// The session list's feed, which a chat's file count moving names the chat to.
    pub(crate) list_feed: Arc<SessionListFeed>,
    /// The daemon's stop, which ends every health pass and every send.
    pub(crate) stop: CancellationToken,
    /// The daemon's worktrees folder, made and resolved by the start.
    pub(crate) worktrees_folder: PathBuf,
    /// The instant the chats' write watch walks from for the writes it has not reported.
    pub(crate) missed_since: SystemTime,
}

/// The repository services, each built once for the daemon's life.
pub(crate) struct RepoServices {
    /// The repository mounts of this machine.
    pub(crate) mounts: Arc<RepoMountService>,
    /// The chats' managed workspaces and the watch of their writes; the stop ends both through
    /// [`ManagedWorkspaceService::stop`].
    pub(crate) workspaces: Arc<ManagedWorkspaceService>,
    /// The broker git's questions go through, or the text every clone verb answers
    /// `project.clone.unavailable` with, empty where the system has no private askpass socket; the
    /// start takes it for the clone service, which owns the broker from then on.
    pub(crate) askpass: Option<Result<AskpassBroker, String>>,
    /// The watch over each working folder; the stop stops it.
    pub(crate) folder_watch: Arc<WorkingFolderWatcher>,
    /// Each live project's repository fetched in the background; the stop stops it.
    pub(crate) fetch: Arc<BackgroundFetch>,
    /// Each live session's working folder held watched and its repository fetched.
    pub(crate) live_folders: Arc<LiveSessionFolders>,
    /// A repository's branches, for the new-worktree form.
    pub(crate) branches: Arc<BranchListReader>,
    /// Each session's review notes, read against its live working folder.
    pub(crate) review_notes: Arc<SessionReviewNoteStore>,
    /// Every worktree transition and worktree-scoped git call.
    pub(crate) worktrees: Arc<WorktreeService>,
    /// The seam each worktree's events are appended through.
    pub(crate) worktree_events: Arc<WorktreeEventEmitter>,
    /// Each turn's checkout snapshot and the prune of a run's snapshot refs.
    pub(crate) snapshots: Arc<TurnSnapshotService>,
    /// The mounts' health, re-probed on the slow tick, a wake and a repository's change.
    pub(crate) mount_health: Arc<RepoMountHealthReprobe>,
    /// The daemon's one scheduler, which runs the re-probe's tick.
    pub(crate) scheduler: Arc<Scheduler>,
    /// The daemon's stop, which also ends the re-probe's triggers.
    pub(crate) stop: CancellationToken,
    /// The chats' writes the managed workspaces' watch reports, for a chat's file versions; the
    /// start takes it for the session services before the repository attachments start.
    pub(crate) workspace_writes: Option<mpsc::Receiver<ManagedWorkspaceReport>>,
    /// The seam each workspace's events are appended through.
    pub(crate) workspace_events: Arc<WorkspaceEventEmitter>,
    /// The daemon's one occupancy reader, for the sessions standing and running in each folder.
    pub(crate) occupancy: MountOccupancyReader,
    /// The daemon's worktrees folder, its links resolved.
    pub(crate) worktrees_folder: PathBuf,
    /// The one keeper of the instant the chats' write watch walks from at the next start, through
    /// which the recording of the chats' writes stores each instant once every write reported
    /// before it is recorded, the clean stop's instant included.
    pub(crate) managed_writes_watermark: Arc<dyn ManagedWritesWatermark>,
}

/// Why the repository services could not be built.
#[derive(Debug, thiserror::Error)]
pub(crate) enum RepoServiceStartError {
    /// Another daemon binds the askpass program's socket in the run folder.
    #[error(transparent)]
    AlreadyRunning(#[from] DaemonAlreadyRunningError),
}

/// Builds the repository services from `start`. Fails only when another daemon binds the askpass
/// program's socket in the run folder; any other broker failure leaves clones unavailable and the
/// start going on. Runs inside the daemon's runtime.
pub(crate) fn build_repo_services(
    start: RepoServiceStart,
) -> Result<RepoServices, RepoServiceStartError> {
    let RepoServiceStart {
        home_folder,
        run_folder,
        daemon_program,
        git,
        reads,
        writer,
        event_log,
        machine_id,
        scheduler,
        list_feed,
        stop,
        worktrees_folder,
        missed_since,
    } = start;
    let workspace_events = Arc::new(WorkspaceEventEmitter::new(Arc::clone(&event_log)));
    let mounts = Arc::new(RepoMountService::new(
        Arc::clone(&writer),
        Arc::clone(&reads),
        Arc::clone(&workspace_events),
        RepoRootResolver::new(git.clone()),
        machine_id,
    ));
    let (writes, workspace_writes) = mpsc::channel(MANAGED_WORKSPACE_WRITE_CAPACITY);
    let managed_writes_watermark: Arc<dyn ManagedWritesWatermark> =
        Arc::new(ManagedWritesWatermarkFile {
            path: managed_writes_watermark_path(&home_folder),
        });
    let workspaces = Arc::new(ManagedWorkspaceService::new(
        &home_folder,
        // A folder in WSL or on Windows itself is the Windows build's to place.
        None,
        Arc::clone(&mounts),
        git.clone(),
        writes,
        list_feed,
        missed_since,
    ));
    let askpass = askpass_or_unavailable(
        AskpassBroker::start(&run_folder, git_askpass_program_path(&daemon_program)),
        &run_folder,
    )?;
    let occupancy = MountOccupancyReader::new(Arc::clone(&reads));
    let worktree_events = Arc::new(WorktreeEventEmitter::new(event_log));
    let folder_watch = Arc::new(WorkingFolderWatcher::new(WorkingFolderWatcherDeps {
        git: git.clone(),
        reads: Arc::clone(&reads),
        occupancy: occupancy.clone(),
        events: Arc::clone(&worktree_events),
        scheduler: Arc::clone(&scheduler),
        read_watch_ceiling: inotify_watch_ceiling,
        slow_tick_interval: SLOW_TICK_INTERVAL,
    }));
    let fetch = Arc::new(BackgroundFetch::new(BackgroundFetchDeps {
        git: git.clone(),
        writer: Arc::clone(&writer),
        scheduler: Arc::clone(&scheduler),
    }));
    let live_folders = Arc::new(LiveSessionFolders::new(LiveSessionFoldersDeps {
        reads: Arc::clone(&reads),
        git: git.clone(),
        watcher: Arc::clone(&folder_watch),
        fetch: Arc::clone(&fetch),
    }));
    let review_notes = Arc::new(live_folders.review_note_store(Arc::clone(&writer)));
    let snapshots = Arc::new(TurnSnapshotService::new(
        git.clone(),
        Arc::clone(&reads),
        &worktrees_folder,
    ));
    let worktrees = Arc::new(WorktreeService::new(WorktreeServiceDeps {
        git: git.clone(),
        reads: Arc::clone(&reads),
        writer,
        events: Arc::clone(&worktree_events),
        occupancy: occupancy.clone(),
        worktrees_folder: worktrees_folder.clone(),
    }));
    let mount_health = Arc::new(RepoMountHealthReprobe::new(
        Arc::clone(&reads),
        Arc::clone(&workspace_events),
        RepoRootResolver::new(git.clone()),
        stop.clone(),
    ));
    Ok(RepoServices {
        branches: Arc::new(BranchListReader::new(git, reads)),
        mounts,
        workspaces,
        askpass: Some(askpass),
        folder_watch,
        fetch,
        live_folders,
        review_notes,
        worktrees,
        worktree_events,
        snapshots,
        mount_health,
        scheduler,
        stop,
        workspace_writes: Some(workspace_writes),
        workspace_events,
        occupancy,
        worktrees_folder,
        managed_writes_watermark,
    })
}

/// Makes the daemon's worktrees folder under `home_folder` and answers it with every link
/// resolved, so each tree's stored folder is the one git records. Fails with the system's error.
pub(crate) async fn make_worktrees_folder(home_folder: &Path) -> io::Result<PathBuf> {
    let folder = worktrees_folder(home_folder);
    tokio::fs::create_dir_all(&folder).await?;
    resolve_real_path(&folder).await
}

/// The record of the instant the chats' write watch walks from, in the data folder under
/// `home_folder`.
pub(crate) fn managed_writes_watermark_path(home_folder: &Path) -> PathBuf {
    data_folder(home_folder).join(MANAGED_WRITES_WATERMARK_FILE_NAME)
}

/// Reads the instant the record at `path` holds: the one the last clean stop stored, or the one
/// the last walk of the chats' writes caught up to, stored once every write it sent was recorded.
/// A missing or unreadable record reads as the epoch, so the walk reads every write; an unreadable
/// record is logged.
pub(crate) async fn read_managed_writes_watermark(path: &Path) -> SystemTime {
    match tokio::fs::read_to_string(path).await.none_if_missing() {
        Ok(Some(text)) => text.trim().parse::<u64>().map_or_else(
            |error| {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "the chats' write watermark is no instant, so the chats' folders are walked \
                     whole"
                );
                UNIX_EPOCH
            },
            |nanoseconds| UNIX_EPOCH + Duration::from_nanos(nanoseconds),
        ),
        Ok(None) => UNIX_EPOCH,
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "the chats' write watermark could not be read, so the chats' folders are walked \
                 whole"
            );
            UNIX_EPOCH
        }
    }
}

/// The record at `path`, [`managed_writes_watermark_path`] under the daemon's home, that keeps the
/// instant the next start's walk of the chats' writes begins at.
struct ManagedWritesWatermarkFile {
    path: PathBuf,
}

impl ManagedWritesWatermark for ManagedWritesWatermarkFile {
    fn store(&self, instant: SystemTime) -> BoxFuture<'_, ()> {
        async move {
            // An instant before the epoch is stored as the epoch.
            let nanoseconds = instant.duration_since(UNIX_EPOCH).map_or(0, |since| {
                u64::try_from(since.as_nanos()).unwrap_or(u64::MAX)
            });
            if let Err(error) = write_file_atomically(
                &self.path,
                nanoseconds.to_string(),
                MANAGED_WRITES_WATERMARK_MODE,
            )
            .await
            {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "the chats' write watermark could not be stored, so the next start walks from \
                     an earlier instant"
                );
            }
        }
        .boxed()
    }
}

/// Why the repository services' background work could not begin.
#[derive(Debug, thiserror::Error)]
pub(crate) enum RepoAttachmentStartError {
    /// The live sessions' folders could not be read.
    #[error(transparent)]
    LiveFolders(#[from] LiveFolderError),
    /// The scheduler had stopped, so the health re-probe's tick could not be scheduled.
    #[error(transparent)]
    Schedule(#[from] ScheduleError),
}

/// The repository services' background work, held for the stop.
pub(crate) struct RepoAttachments {
    health_tick: ScheduledJobHandle,
    health_triggers: JoinHandle<()>,
}

/// Begins the repository services' background work: the live sessions' folders following
/// `followers`, and the mounts' health probed now, then re-probed on the slow tick, on a wake and
/// on a repository's change. Called once the start's recovery pass has settled the runs, inside
/// the daemon's runtime. Fails when the live sessions cannot be read or the scheduler has stopped.
pub(crate) async fn start_repo_attachments(
    services: &RepoServices,
    followers: &Arc<SessionEventFollowers>,
) -> Result<RepoAttachments, RepoAttachmentStartError> {
    let tick = Arc::new(Notify::new());
    let ticking = Arc::clone(&tick);
    // The job only wakes the triggers' task, so a slow probe holds no other job.
    let health_tick = services.scheduler.schedule_repeating(
        "repository health re-probe",
        JobCondition::Always,
        SLOW_TICK_INTERVAL,
        SLOW_TICK_INTERVAL,
        move |_stop| {
            ticking.notify_one();
            async { Ok(()) }.boxed()
        },
    )?;
    if let Err(error) = services.live_folders.start(followers).await {
        health_tick.cancel();
        // The start attaches its follow before the read that failed.
        tokio::join!(services.live_folders.stop(), services.fetch.stop());
        return Err(error.into());
    }
    let health_triggers = tokio::spawn(reprobe_mount_health(
        Arc::clone(&services.mount_health),
        tick,
        services.folder_watch.on_repository_change(),
        services.scheduler.on_wake(),
        services.stop.clone(),
    ));
    Ok(RepoAttachments {
        health_tick,
        health_triggers,
    })
}

impl RepoAttachments {
    /// Ends the background work: the health re-probe's tick and triggers, the live sessions'
    /// folders and the fetches, waiting for the work under way. Run after the daemon's stop was
    /// canceled and before the scheduler and the working-folder watch stop; answers the triggers'
    /// task when it ended abnormally.
    pub(crate) async fn stop(self, services: &RepoServices) -> Option<TaskStopFailure> {
        self.health_tick.cancel();
        let (triggers, (), ()) = tokio::join!(
            self.health_triggers,
            services.live_folders.stop(),
            services.fetch.stop(),
        );
        triggers.err().map(|error| TaskStopFailure {
            task: "repository health re-probe",
            error,
        })
    }
}

// What asks the mounts' health to be probed again.
enum ReprobeTrigger {
    Every,
    Containing(PathBuf),
}

// Probes every mount's health, then re-probes on each trigger until `stop`: every mount on a
// `tick` or a wake or once `changes` fell behind, and the mounts holding a folder whose
// repository may have moved.
async fn reprobe_mount_health(
    health: Arc<RepoMountHealthReprobe>,
    tick: Arc<Notify>,
    mut changes: broadcast::Receiver<PathBuf>,
    mut wakes: broadcast::Receiver<WakeSignal>,
    stop: CancellationToken,
) {
    log_reprobe_failure(health.start_probe().await);
    let mut is_waking = true;
    loop {
        let trigger = tokio::select! {
            () = stop.cancelled() => return,
            () = tick.notified() => ReprobeTrigger::Every,
            change = changes.recv() => match change {
                Ok(folder) => ReprobeTrigger::Containing(folder),
                Err(broadcast::error::RecvError::Lagged(_)) => ReprobeTrigger::Every,
                // The watch has stopped.
                Err(broadcast::error::RecvError::Closed) => return,
            },
            wake = wakes.recv(), if is_waking => match wake {
                Ok(WakeSignal) | Err(broadcast::error::RecvError::Lagged(_)) => {
                    ReprobeTrigger::Every
                }
                Err(broadcast::error::RecvError::Closed) => {
                    is_waking = false;
                    continue;
                }
            },
        };
        log_reprobe_failure(match trigger {
            ReprobeTrigger::Every => health.reprobe().await,
            ReprobeTrigger::Containing(folder) => health.reprobe_mounts_containing(&folder).await,
        });
    }
}

// Logs a re-probe that did not finish; the next trigger probes again.
fn log_reprobe_failure(probed: Result<(), ReprobeError>) {
    if let Err(error) = probed {
        tracing::warn!(
            error = &error as &(dyn Error + 'static),
            "a repository health re-probe did not finish"
        );
    }
}

// The askpass broker `started` in `run_folder`, or, logging why, the text every clone verb is
// refused `project.clone.unavailable` with: empty where the system has no private askpass socket,
// else the failure's own text, the daemon's start going on. A socket another daemon binds there
// fails the start as the daemon's own socket does.
fn askpass_or_unavailable(
    started: Result<AskpassBroker, AskpassBrokerError>,
    run_folder: &Path,
) -> Result<Result<AskpassBroker, String>, RepoServiceStartError> {
    match started {
        Ok(broker) => Ok(Ok(broker)),
        Err(AskpassBrokerError::Listen(error)) if error.kind() == io::ErrorKind::AddrInUse => {
            Err(DaemonAlreadyRunningError {
                held_place: HeldPlace::Socket(askpass_socket_path(run_folder)),
                source: Some(Box::new(error)),
            }
            .into())
        }
        Err(AskpassBrokerError::Listen(error)) if error.kind() == io::ErrorKind::Unsupported => {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "the clone service was not started: this system has no private socket for git's \
                 questions"
            );
            Ok(Err(String::new()))
        }
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "the clone service was not started: its askpass broker could not start"
            );
            Ok(Err(describe_error(&error)))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::path::Path;

    use sidekicks_platforms::askpass_socket_path;
    use sidekicks_workspace::clone::askpass::broker::AskpassBrokerError;

    use super::{RepoServiceStartError, askpass_or_unavailable};
    use crate::daemon::already_running_error::{DaemonAlreadyRunningError, HeldPlace};

    // Every broker failure but another daemon's socket keeps the start: a system with no askpass
    // socket with empty text, any other failure with its own. Killed by the third arm failing the
    // start, by the `Unsupported` arm deleted, and by every failure answered with empty text.
    #[test]
    fn a_broker_that_cannot_start_keeps_the_start_and_carries_its_text() {
        let unsupported = askpass_or_unavailable(
            Err(AskpassBrokerError::Listen(io::Error::from(
                io::ErrorKind::Unsupported,
            ))),
            Path::new("/run"),
        );
        assert!(
            matches!(unsupported, Ok(Err(ref text)) if text.is_empty()),
            "{:?}",
            unsupported.map(|broker| broker.err())
        );

        let refused = askpass_or_unavailable(
            Err(AskpassBrokerError::Listen(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "permission denied",
            ))),
            Path::new("/run"),
        );
        assert!(
            matches!(
                refused,
                Ok(Err(ref text))
                    if text == "the askpass program's socket could not be opened: permission denied"
            ),
            "{:?}",
            refused.map(|broker| broker.err())
        );
    }

    // Killed by the `AddrInUse` arm deleted: another daemon's askpass socket then leaves clones
    // unavailable instead of failing the start as a daemon already running there.
    #[test]
    fn another_daemon_s_askpass_socket_fails_the_start_as_already_running() {
        let run_folder = Path::new("/run/ai-sidekicks");

        let held = askpass_or_unavailable(
            Err(AskpassBrokerError::Listen(io::Error::from(
                io::ErrorKind::AddrInUse,
            ))),
            run_folder,
        );

        assert!(
            matches!(
                held,
                Err(RepoServiceStartError::AlreadyRunning(DaemonAlreadyRunningError {
                    held_place: HeldPlace::Socket(ref path),
                    ..
                })) if *path == askpass_socket_path(run_folder)
            ),
            "{:?}",
            held.map(|broker| broker.err())
        );
    }
}
