//! The repository services the daemon's start builds once on its git: the repository mounts, the
//! chats' managed workspaces, the broker git's questions reach the person through, the watch over
//! each working folder, the live sessions' folders and their projects' fetches, the branch lists,
//! the worktrees, the turn snapshots and the mounts' health re-probe. Their background work begins
//! once the start's recovery pass has settled the runs.

use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::machine::id::MachineId;
use sidekicks_platforms::{askpass_socket_path, inotify_watch_ceiling};
use tokio::sync::{Notify, broadcast, mpsc};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::daemon::already_running_error::{DaemonAlreadyRunningError, HeldPlace};
use crate::daemon::process::stop::TaskStopFailure;
use sidekicks_session::directory::list_feed::SessionListFeed;
use sidekicks_session::live_folders::{
    LiveFolderError, LiveSessionFolders, LiveSessionFoldersDeps,
};
use sidekicks_session::worktree_naming::worktrees_folder;
use sidekicks_std::scheduler::{
    JobCondition, ScheduleError, ScheduledJobHandle, Scheduler, WakeSignal,
};
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
use sidekicks_workspace::git::worktree::occupancy::MountOccupancyReader;
use sidekicks_workspace::git::worktree::service::{WorktreeService, WorktreeServiceDeps};
use sidekicks_workspace::git::worktree::watch::{
    SLOW_TICK_INTERVAL, WorkingFolderWatcher, WorkingFolderWatcherDeps,
};
use sidekicks_workspace::managed::service::ManagedWorkspaceService;
use sidekicks_workspace::managed::write_watcher::ManagedWorkspaceWrite;
use sidekicks_workspace::repo::mount::health::{RepoMountHealthReprobe, ReprobeError};
use sidekicks_workspace::repo::mount::service::RepoMountService;
use sidekicks_workspace::repo::root_resolver::RepoRootResolver;

// The chats' writes the watch may report ahead of their recording; a full channel holds the watch
// until the versions catch up.
const MANAGED_WORKSPACE_WRITE_CAPACITY: usize = 64;

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
}

/// The repository services, each built once for the daemon's life.
pub(crate) struct RepoServices {
    /// The repository mounts of this machine.
    #[expect(dead_code, reason = "the daemon's method tables")]
    pub(crate) mounts: Arc<RepoMountService>,
    /// The chats' managed workspaces and the watch of their writes; the stop ends both through
    /// [`ManagedWorkspaceService::stop`].
    pub(crate) workspaces: Arc<ManagedWorkspaceService>,
    /// The broker git's questions go through, `None` where the system has no private askpass
    /// socket, which leaves clones unavailable; the stop closes it.
    pub(crate) askpass: Option<AskpassBroker>,
    /// The watch over each working folder; the stop stops it.
    pub(crate) folder_watch: Arc<WorkingFolderWatcher>,
    /// Each live project's repository fetched in the background; the stop stops it.
    pub(crate) fetch: Arc<BackgroundFetch>,
    /// Each live session's working folder held watched and its repository fetched.
    pub(crate) live_folders: Arc<LiveSessionFolders>,
    /// A repository's branches, for the new-worktree form.
    #[expect(dead_code, reason = "the daemon's method tables")]
    pub(crate) branches: Arc<BranchListReader>,
    /// Every worktree transition and worktree-scoped git call.
    #[expect(dead_code, reason = "the worktree methods")]
    pub(crate) worktrees: Arc<WorktreeService>,
    /// Each turn's checkout snapshot and the prune of a run's snapshot refs.
    #[expect(dead_code, reason = "the session purge and the checkpoints")]
    pub(crate) snapshots: Arc<TurnSnapshotService>,
    /// The mounts' health, re-probed on the slow tick, a wake and a repository's change.
    pub(crate) mount_health: Arc<RepoMountHealthReprobe>,
    /// The daemon's one scheduler, which runs the re-probe's tick.
    pub(crate) scheduler: Arc<Scheduler>,
    /// The daemon's stop, which also ends the re-probe's triggers.
    pub(crate) stop: CancellationToken,
    /// The chats' writes the managed workspaces' watch reports, for a chat's file versions; the
    /// start takes it for the session services before the repository attachments start.
    #[expect(dead_code, reason = "the session services' build")]
    pub(crate) workspace_writes: Option<mpsc::Receiver<ManagedWorkspaceWrite>>,
}

/// Why the repository services could not be built.
#[derive(Debug, thiserror::Error)]
pub(crate) enum RepoServiceStartError {
    /// The askpass broker could not start.
    #[error(transparent)]
    Askpass(AskpassBrokerError),
    /// Another daemon binds the askpass program's socket in the run folder.
    #[error(transparent)]
    AlreadyRunning(#[from] DaemonAlreadyRunningError),
}

/// Builds the repository services from `start`. Fails when the askpass broker cannot start for
/// any reason but a system with no private askpass socket, which leaves it unstarted. Runs inside
/// the daemon's runtime.
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
    let workspaces = Arc::new(ManagedWorkspaceService::new(
        &home_folder,
        // A folder in WSL or on Windows itself is the Windows build's to place.
        None,
        Arc::clone(&mounts),
        git.clone(),
        writes,
        list_feed,
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
    let worktrees_folder = worktrees_folder(&home_folder);
    let snapshots = Arc::new(TurnSnapshotService::new(
        git.clone(),
        Arc::clone(&reads),
        &worktrees_folder,
    ));
    let worktrees = Arc::new(WorktreeService::new(WorktreeServiceDeps {
        git: git.clone(),
        reads: Arc::clone(&reads),
        writer,
        events: worktree_events,
        occupancy,
        worktrees_folder,
    }));
    let mount_health = Arc::new(RepoMountHealthReprobe::new(
        Arc::clone(&reads),
        workspace_events,
        RepoRootResolver::new(git.clone()),
        stop.clone(),
    ));
    Ok(RepoServices {
        branches: Arc::new(BranchListReader::new(git, reads)),
        mounts,
        workspaces,
        askpass,
        folder_watch,
        fetch,
        live_folders,
        worktrees,
        snapshots,
        mount_health,
        scheduler,
        stop,
        workspace_writes: Some(workspace_writes),
    })
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

// The askpass broker `started` in `run_folder`, or `None`, logging why, where the system has no
// private askpass socket; every clone call is then refused `project.clone.unavailable`. A socket
// another daemon binds there fails the start as the daemon's own socket does.
fn askpass_or_unavailable(
    started: Result<AskpassBroker, AskpassBrokerError>,
    run_folder: &Path,
) -> Result<Option<AskpassBroker>, RepoServiceStartError> {
    match started {
        Ok(broker) => Ok(Some(broker)),
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
            Ok(None)
        }
        Err(error) => Err(RepoServiceStartError::Askpass(error)),
    }
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::path::{Path, PathBuf};

    use sidekicks_platforms::askpass_socket_path;

    use super::{RepoServiceStartError, askpass_or_unavailable};
    use crate::daemon::already_running_error::{DaemonAlreadyRunningError, HeldPlace};
    use sidekicks_workspace::clone::askpass::broker::{AskpassBroker, AskpassBrokerError};

    // The first case is killed by the `Unsupported` arm deleted, which fails the start where the
    // system has no askpass socket; the second by the `Unsupported` guard widened to every listen
    // error, which answers `None` for a run folder whose socket path is past the system's bound.
    #[tokio::test]
    async fn only_a_system_with_no_askpass_socket_leaves_the_broker_unstarted() {
        let unsupported = askpass_or_unavailable(
            Err(AskpassBrokerError::Listen(io::Error::from(
                io::ErrorKind::Unsupported,
            ))),
            Path::new("/run"),
        );
        assert!(
            matches!(unsupported, Ok(None)),
            "{:?}",
            unsupported.map(|broker| broker.is_some())
        );

        let run_folder = PathBuf::from("/").join("a".repeat(200));
        let started = AskpassBroker::start(&run_folder, PathBuf::from("askpass-program"));
        // Where the system has no askpass socket, no path is past its bound.
        if matches!(
            started,
            Err(AskpassBrokerError::Listen(ref error)) if error.kind() == io::ErrorKind::Unsupported
        ) {
            return;
        }
        let past_the_bound = askpass_or_unavailable(started, &run_folder);
        assert!(
            matches!(
                past_the_bound,
                Err(RepoServiceStartError::Askpass(AskpassBrokerError::Listen(ref error)))
                    if error.kind() == io::ErrorKind::InvalidInput
            ),
            "{:?}",
            past_the_bound.as_ref().map(Option::is_some)
        );
    }

    // Killed by the `AddrInUse` arm deleted: another daemon's askpass socket then fails the start
    // as a broker that could not start, not as a daemon already running there.
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
            held.map(|broker| broker.is_some())
        );
    }
}
