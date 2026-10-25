//! The repository services the daemon's start builds once: its git, the repository mounts, the
//! chats' managed workspaces, the broker git's questions reach the person through, and the watch
//! over each working folder.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sidekicks_contracts::machine::id::MachineId;
use sidekicks_platforms::{Spawner, inotify_watch_ceiling};
use tokio::sync::mpsc;

use crate::daemon::scheduler::Scheduler;
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::DatabaseWriter;
use crate::events::log_service::EventLogService;
use crate::git::process::{GitLimits, GitRunner};
use crate::git::worktree::event_emitter::WorktreeEventEmitter;
use crate::git::worktree::occupancy::MountOccupancyReader;
use crate::git::worktree::watch::{
    SLOW_TICK_INTERVAL, WorkingFolderWatcher, WorkingFolderWatcherDeps,
};
use crate::session::directory::list_feed::SessionListFeed;
use crate::workspace::clone::askpass::broker::{AskpassBroker, AskpassBrokerError};
use crate::workspace::clone::askpass::program::git_askpass_program_path;
use crate::workspace::event_emitter::WorkspaceEventEmitter;
use crate::workspace::managed::service::ManagedWorkspaceService;
use crate::workspace::managed::write_watcher::ManagedWorkspaceWrite;
use crate::workspace::repo::mount::service::RepoMountService;
use crate::workspace::repo::root_resolver::RepoRootResolver;

// The chats' writes the watch may report ahead of their recording; a full channel holds the watch
// until the versions catch up.
const MANAGED_WORKSPACE_WRITE_CAPACITY: usize = 64;

/// What the repository services are built from.
pub(crate) struct RepoServiceStart {
    /// The person's home, which holds the chats' managed workspaces.
    pub(crate) home_folder: PathBuf,
    /// The run folder, private to this account, where the askpass broker's socket goes.
    pub(crate) run_folder: PathBuf,
    /// The thread every git child starts on.
    pub(crate) spawner: Spawner,
    /// Git along the person's search path, when the start found it.
    pub(crate) git_executable: Option<PathBuf>,
    /// The login shell's environment, which every git call starts from.
    pub(crate) base_environment: Arc<[(String, String)]>,
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
}

/// The repository services, each built once for the daemon's life.
#[expect(
    dead_code,
    reason = "the daemon's start, its method tables and its stop, which the composition wires"
)]
pub(crate) struct RepoServices {
    /// The daemon's git; the stop waits for the trees its failed calls left ending.
    pub(crate) git: GitRunner,
    /// The repository mounts of this machine.
    pub(crate) mounts: Arc<RepoMountService>,
    /// The chats' managed workspaces and the watch of their writes; dropping it ends both.
    pub(crate) workspaces: Arc<ManagedWorkspaceService>,
    /// The broker git's questions go through, `None` where the system has no private askpass
    /// socket, which leaves clones unavailable; the stop closes it.
    pub(crate) askpass: Option<AskpassBroker>,
    /// The watch over each working folder; the stop stops it.
    pub(crate) folder_watch: Arc<WorkingFolderWatcher>,
    /// The chats' writes the managed workspaces' watch reports, for a chat's file versions.
    pub(crate) workspace_writes: mpsc::Receiver<ManagedWorkspaceWrite>,
}

/// Why the repository services could not be built.
#[derive(Debug, thiserror::Error)]
pub(crate) enum RepoServiceStartError {
    /// The daemon's own program could not be found for git's askpass program beside it.
    #[error("the daemon's own program could not be found for git's askpass program")]
    AskpassProgram(#[source] io::Error),
    /// The askpass broker could not start.
    #[error(transparent)]
    Askpass(AskpassBrokerError),
}

/// Builds the repository services from `start`. Fails when the askpass broker cannot start for
/// any reason but a system with no private askpass socket, which leaves it unstarted. Runs inside
/// the daemon's runtime.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the daemon's start, which the composition wires")
)]
pub(crate) fn build_repo_services(
    start: RepoServiceStart,
) -> Result<RepoServices, RepoServiceStartError> {
    let RepoServiceStart {
        home_folder,
        run_folder,
        spawner,
        git_executable,
        base_environment,
        reads,
        writer,
        event_log,
        machine_id,
        scheduler,
        list_feed,
    } = start;
    let git = GitRunner::new(spawner, git_executable, base_environment, GitLimits::DAEMON);
    let mounts = Arc::new(RepoMountService::new(
        writer,
        Arc::clone(&reads),
        Arc::new(WorkspaceEventEmitter::new(Arc::clone(&event_log))),
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
    let askpass = start_askpass_broker(&run_folder)?;
    let folder_watch = Arc::new(WorkingFolderWatcher::new(WorkingFolderWatcherDeps {
        git: git.clone(),
        reads: Arc::clone(&reads),
        occupancy: MountOccupancyReader::new(reads),
        events: Arc::new(WorktreeEventEmitter::new(event_log)),
        scheduler,
        read_watch_ceiling: inotify_watch_ceiling,
        slow_tick_interval: SLOW_TICK_INTERVAL,
    }));
    Ok(RepoServices {
        git,
        mounts,
        workspaces,
        askpass,
        folder_watch,
        workspace_writes,
    })
}

// Starts the askpass broker in `run_folder`, or answers `None`, logging why, where the system has
// no private askpass socket; every clone call is then refused `project.clone.unavailable`.
fn start_askpass_broker(run_folder: &Path) -> Result<Option<AskpassBroker>, RepoServiceStartError> {
    let program_path = git_askpass_program_path().map_err(RepoServiceStartError::AskpassProgram)?;
    match AskpassBroker::start(run_folder, program_path) {
        Ok(broker) => Ok(Some(broker)),
        Err(AskpassBrokerError::Listen(error)) if error.kind() == io::ErrorKind::Unsupported => {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "the clone service was not started: this system has no private socket for git's \
                 questions"
            );
            Ok(None)
        }
        Err(error) => Err(RepoServiceStartError::Askpass(error)),
    }
}
