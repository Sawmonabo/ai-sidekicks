//! The workspace services the daemon's start builds over its repository services, in two steps.
//! Before the run engine: the workspace lifecycle, the execution roots, the re-attach, the
//! sessions' working-folder moves and the run setup gate they make up. After the session services
//! and the terminals: the kept worktrees and the removal, the switcher's status read, the folders'
//! usage, the session create and convert, and the one worktree cleanup job. Here too is their work
//! at the start, which finishes what a stop cut off, and its end at the stop.

use std::error::Error;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use futures::FutureExt as _;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_session::changes::SessionChanges;
use sidekicks_session::convert::{
    SessionConversion, SessionConversionDeps, SessionConversionError,
};
use sidekicks_session::create::{SessionCreateError, SessionCreation, SessionCreationDeps};
use sidekicks_session::run::folders::SessionLiveRunFolders;
use sidekicks_session::working_folder::{SessionWorkingFolders, SessionWorkingFoldersDeps};
use sidekicks_shell::table::ShellTable;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::{JobCondition, ScheduledJobOutcome, Scheduler, WakeSignal};
use sidekicks_std::settle_all::SettleFailures;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::DatabaseWriter;
use sidekicks_store::events::log_service::EventLogService;
use sidekicks_store::events::session::appender::SessionEventAppender;
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;
use sidekicks_workspace::execution_root::{ExecutionRootService, ExecutionRootServiceDeps};
use sidekicks_workspace::folder::usage::RepoFolderUsage;
use sidekicks_workspace::git::process::GitRunner;
use sidekicks_workspace::git::worktree::copy::progress::WorktreeCopiesUnderWay;
use sidekicks_workspace::git::worktree::creation::WorktreeCreator;
use sidekicks_workspace::git::worktree::path_holds::PathHolds;
use sidekicks_workspace::git::worktree::removal::{
    FolderProcessOwner, WorktreeRemoval, WorktreeRemovalDeps,
};
use sidekicks_workspace::git::worktree::removed_store::{
    RemovedWorktreeStore, RemovedWorktreeStoreDeps,
};
use sidekicks_workspace::git::worktree::service::WorktreeService;
use sidekicks_workspace::git::worktree::setup::WorktreeSetupRunner;
use sidekicks_workspace::git::worktree::status::{WorktreeStatusReader, WorktreeStatusReaderDeps};
use sidekicks_workspace::machine_settings::MachineSettingsReader;
use sidekicks_workspace::project::list_feed::ProjectListFeed;
use sidekicks_workspace::project::records::ProjectRecords;
use sidekicks_workspace::project::service::ProjectService;
use sidekicks_workspace::repo::mount::reattach::{
    RepoMountReattachService, RepoMountReattachServiceDeps,
};
use sidekicks_workspace::repo::mount::service::RepoMountService;
use sidekicks_workspace::repo::root_resolver::RepoRootResolver;
use sidekicks_workspace::run_setup_gates::execution_root::{
    ExecutionRootSetupGate, ExecutionRootSetupGateDeps,
};
use sidekicks_workspace::service::{WorkspaceService, WorkspaceServiceDeps};
use tokio::sync::broadcast;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::daemon::process::repo_services::RepoServices;
use crate::daemon::process::stop::{DaemonStopFailure, TaskStopFailure};

// The cleanup job's name in the service log.
const WORKTREE_CLEANUP_JOB_NAME: &str = "worktree cleanup";

/// What the execution roots and their run setup gate are built from.
pub(crate) struct ExecutionRootStart<'start> {
    /// The daemon's one read pool.
    pub(crate) reads: Arc<DatabaseReadPool>,
    /// The daemon's one writer.
    pub(crate) writer: Arc<DatabaseWriter>,
    /// The daemon's git.
    pub(crate) git: GitRunner,
    /// The repository services, whose event seams and worktree service these take.
    pub(crate) repo: &'start RepoServices,
    /// Makes the worktrees.
    pub(crate) creator: Arc<WorktreeCreator>,
    /// The setup card of every worktree made.
    pub(crate) setup: Arc<WorktreeSetupRunner>,
    /// Reads the agent a running run is for, the one the creator reads live runs through.
    pub(crate) live_run_folders: Arc<SessionLiveRunFolders>,
    /// The creator's per-checkout lock, which the gate holds around a run's context write.
    pub(crate) checkout_lock: Arc<KeyedLock<PathBuf>>,
    /// The live projects list, told when a run's held root changes.
    pub(crate) project_list_feed: Arc<ProjectListFeed>,
}

/// The workspace lifecycle and the execution roots, with the run setup gate built over them.
pub(crate) struct ExecutionRootServices {
    /// The workspace lifecycle.
    pub(crate) workspaces: Arc<WorkspaceService>,
    /// The owner of every workspace's preparation hold.
    pub(crate) execution_roots: Arc<ExecutionRootService>,
    /// Re-attaches a mount whose folder holds another repository now.
    pub(crate) reattach: Arc<RepoMountReattachService>,
    /// The sessions' working-folder moves and the sweep out of a removed tree.
    pub(crate) session_working_folders: Arc<SessionWorkingFolders>,
    /// Binds each repository-bound run to its working folder.
    pub(crate) gate: Arc<ExecutionRootSetupGate>,
}

/// Builds the workspace lifecycle, the execution roots, the re-attach and the working-folder
/// moves over one execution root service, and the run setup gate over all of them.
pub(crate) fn build_execution_root_services(
    start: ExecutionRootStart<'_>,
) -> ExecutionRootServices {
    let ExecutionRootStart {
        reads,
        writer,
        git,
        repo,
        creator,
        setup,
        live_run_folders,
        checkout_lock,
        project_list_feed,
    } = start;
    let workspaces = Arc::new(WorkspaceService::new(WorkspaceServiceDeps {
        reads: Arc::clone(&reads),
        events: Arc::clone(&repo.workspace_events),
        resolver: RepoRootResolver::new(git.clone()),
    }));
    let execution_roots = Arc::new(ExecutionRootService::new(ExecutionRootServiceDeps {
        writer: Arc::clone(&writer),
        reads: Arc::clone(&reads),
        git: git.clone(),
        workspaces: Arc::clone(&workspaces),
        worktrees: Arc::clone(&repo.worktrees),
        creator,
        setup,
    }));
    let reattach = Arc::new(RepoMountReattachService::new(
        RepoMountReattachServiceDeps {
            writer: Arc::clone(&writer),
            reads: Arc::clone(&reads),
            workspaces: Arc::clone(&workspaces),
            execution_roots: Arc::clone(&execution_roots),
            events: Arc::clone(&repo.workspace_events),
            worktree_events: Arc::clone(&repo.worktree_events),
            resolver: RepoRootResolver::new(git.clone()),
            agents: live_run_folders,
        },
    ));
    let session_working_folders = Arc::new(SessionWorkingFolders::new(SessionWorkingFoldersDeps {
        reads: Arc::clone(&reads),
        writer: Arc::clone(&writer),
        execution_roots: Arc::clone(&execution_roots),
        worktree_events: Arc::clone(&repo.worktree_events),
    }));
    let gate = Arc::new(ExecutionRootSetupGate::new(ExecutionRootSetupGateDeps {
        writer,
        reads,
        git,
        workspaces: Arc::clone(&workspaces),
        execution_roots: Arc::clone(&execution_roots),
        reattach: Arc::clone(&reattach),
        moves: Arc::clone(&session_working_folders) as _,
        checkout_lock,
        list_feed: project_list_feed,
    }));
    ExecutionRootServices {
        workspaces,
        execution_roots,
        reattach,
        session_working_folders,
        gate,
    }
}

/// What the rest of the workspace services are built from.
pub(crate) struct WorkspaceServiceStart<'start> {
    /// The daemon's one read pool.
    pub(crate) reads: Arc<DatabaseReadPool>,
    /// The daemon's one writer.
    pub(crate) writer: Arc<DatabaseWriter>,
    /// The daemon's one event log, which a conversion appends to.
    pub(crate) event_log: Arc<EventLogService>,
    /// The daemon's git.
    pub(crate) git: GitRunner,
    /// The repository services.
    pub(crate) repo: &'start RepoServices,
    /// The execution roots and the services over them.
    pub(crate) roots: &'start ExecutionRootServices,
    /// Makes the worktrees, and answers the new-worktree form's suggestion.
    pub(crate) creator: Arc<WorktreeCreator>,
    /// The setup card of every worktree made, whose commands a removal ends.
    pub(crate) setup: Arc<WorktreeSetupRunner>,
    /// Each session's shells, which a removal ends in the tree.
    pub(crate) shells: Arc<ShellTable>,
    /// Appends a created session's events.
    pub(crate) appender: Arc<SessionEventAppender>,
    /// The registered drivers.
    pub(crate) providers: Arc<ProviderRegistry>,
    /// The machine's settings.
    pub(crate) settings: Arc<dyn MachineSettingsReader>,
    /// The sessions' renames, whose transition lock a conversion holds.
    pub(crate) changes: Arc<SessionChanges>,
    /// The projects' edits.
    pub(crate) projects: Arc<ProjectService>,
    /// The projects' rows.
    pub(crate) records: Arc<ProjectRecords>,
    /// The live projects list.
    pub(crate) project_list_feed: Arc<ProjectListFeed>,
    /// The daemon's one scheduler, which runs the worktree cleanup job.
    pub(crate) scheduler: Arc<Scheduler>,
}

/// The repository mount methods' inputs.
pub(crate) struct RepoMountMethods {
    /// The projects' edits, which attach and detach a mount.
    pub(crate) projects: Arc<ProjectService>,
    /// The repository mounts.
    pub(crate) mounts: Arc<RepoMountService>,
    /// The folders the service can reach and the sessions using each.
    pub(crate) usage: Arc<RepoFolderUsage>,
    /// Re-attaches a mount whose folder holds another repository now.
    pub(crate) reattach: Arc<RepoMountReattachService>,
    /// The setup card of every worktree made, whose retired trees a re-attach forgets.
    pub(crate) setup: Arc<WorktreeSetupRunner>,
    /// The live projects list, which a re-attach moves a project's mount in without an event.
    pub(crate) list_feed: Arc<ProjectListFeed>,
    /// Requests the worktree cleanup after a detach.
    pub(crate) cleanup: WorktreeCleanupRequests,
}

/// The worktree methods' inputs.
pub(crate) struct WorktreeMethods {
    /// Removes a tree, keeping aside what it would lose.
    pub(crate) removal: Arc<WorktreeRemoval>,
    /// The kept worktrees.
    pub(crate) removed: Arc<RemovedWorktreeStore>,
    /// The switcher's list.
    pub(crate) status: Arc<WorktreeStatusReader>,
    /// The setup card of every worktree made.
    pub(crate) setup: Arc<WorktreeSetupRunner>,
    /// The copies across volumes under way.
    pub(crate) copies: WorktreeCopiesUnderWay,
    /// The projects' rows, which a project's id is checked against.
    pub(crate) records: Arc<ProjectRecords>,
    /// Requests the worktree cleanup after a retire.
    pub(crate) cleanup: WorktreeCleanupRequests,
}

/// The rest of the workspace services: the method tables' inputs and the work the start begins.
pub(crate) struct WorkspaceServices {
    /// The repository mount methods' inputs.
    pub(crate) repo_mounts: RepoMountMethods,
    /// The worktree methods' inputs.
    pub(crate) worktree_methods: WorktreeMethods,
    /// Creates sessions.
    pub(crate) creation: Arc<SessionCreation>,
    /// Turns chats into projects.
    pub(crate) conversion: Arc<SessionConversion>,
    /// The start's and the stop's part of them.
    pub(crate) work: WorkspaceWork,
}

/// Builds the kept worktrees' store and the removal, the switcher's status read, the folders'
/// usage, the session create and convert, and the worktree cleanup job's requests.
pub(crate) fn build_workspace_services(start: WorkspaceServiceStart<'_>) -> WorkspaceServices {
    let WorkspaceServiceStart {
        reads,
        writer,
        event_log,
        git,
        repo,
        roots,
        creator,
        setup,
        shells,
        appender,
        providers,
        settings,
        changes,
        projects,
        records,
        project_list_feed,
        scheduler,
    } = start;
    let copies = WorktreeCopiesUnderWay::default();
    let removed = Arc::new(RemovedWorktreeStore::new(RemovedWorktreeStoreDeps {
        git: git.clone(),
        reads: Arc::clone(&reads),
        writer: Arc::clone(&writer),
        worktrees: Arc::clone(&repo.worktrees),
        copies: copies.clone(),
        names_in_use: Arc::new(PathHolds::default()),
        kept_copy_lock: Arc::new(KeyedLock::new()),
        worktrees_folder: repo.worktrees_folder.clone(),
    }));
    let owners: Vec<Arc<dyn FolderProcessOwner>> = vec![Arc::clone(&setup) as _, shells as _];
    let removal = Arc::new(WorktreeRemoval::new(WorktreeRemovalDeps {
        git: git.clone(),
        worktrees: Arc::clone(&repo.worktrees),
        removed_worktrees: Arc::clone(&removed),
        occupancy: repo.occupancy.clone(),
        process_owners: owners.clone(),
        sessions: Arc::clone(&roots.session_working_folders) as _,
        worktrees_folder: repo.worktrees_folder.clone(),
    }));
    let cleanup = WorktreeCleanupRequests {
        shared: Arc::new(WorktreeCleanup {
            scheduler,
            worktrees: Arc::clone(&repo.worktrees),
            removal: Arc::clone(&removal),
            setup: Arc::clone(&setup),
            owners,
            is_requested: AtomicBool::new(false),
            is_stopping: AtomicBool::new(false),
            wake_requests: Mutex::new(None),
        }),
    };
    let creation = Arc::new(SessionCreation::new(SessionCreationDeps {
        reads: Arc::clone(&reads),
        appender,
        providers,
        workspaces: Arc::clone(&roots.workspaces),
        managed_workspaces: Arc::clone(&repo.workspaces),
        settings,
    }));
    let conversion = Arc::new(SessionConversion::new(SessionConversionDeps {
        reads: Arc::clone(&reads),
        writer,
        appender: SessionEventAppender::new(event_log, SESSION_EVENT_VERSION.clone()),
        changes,
        mounts: Arc::clone(&repo.mounts),
        projects: Arc::clone(&projects),
        workspaces: Arc::clone(&roots.workspaces),
        resolver: Arc::new(RepoRootResolver::new(git.clone())),
    }));
    WorkspaceServices {
        repo_mounts: RepoMountMethods {
            projects,
            mounts: Arc::clone(&repo.mounts),
            usage: Arc::new(RepoFolderUsage::new(
                Arc::clone(&reads),
                repo.occupancy.clone(),
            )),
            reattach: Arc::clone(&roots.reattach),
            setup: Arc::clone(&setup),
            list_feed: project_list_feed,
            cleanup: cleanup.clone(),
        },
        worktree_methods: WorktreeMethods {
            removal,
            removed: Arc::clone(&removed),
            status: Arc::new(WorktreeStatusReader::new(WorktreeStatusReaderDeps {
                git,
                reads,
                occupancy: repo.occupancy.clone(),
                new_worktree: creator,
            })),
            setup,
            copies,
            records,
            cleanup: cleanup.clone(),
        },
        creation: Arc::clone(&creation),
        conversion: Arc::clone(&conversion),
        work: WorkspaceWork {
            creation,
            conversion,
            cleanup,
            removed,
            start_tasks: Vec::new(),
        },
    }
}

/// Requests the one worktree cleanup job. Requests made before a pass begins share it, one made
/// while a pass runs schedules the next, and none is made once the stop has begun.
#[derive(Clone)]
pub(crate) struct WorktreeCleanupRequests {
    shared: Arc<WorktreeCleanup>,
}

// What every request and the job's runs share.
struct WorktreeCleanup {
    scheduler: Arc<Scheduler>,
    worktrees: Arc<WorktreeService>,
    removal: Arc<WorktreeRemoval>,
    setup: Arc<WorktreeSetupRunner>,
    owners: Vec<Arc<dyn FolderProcessOwner>>,
    // Set from a request until its pass begins.
    is_requested: AtomicBool,
    is_stopping: AtomicBool,
    // The task that requests a pass on each wake of the machine.
    wake_requests: Mutex<Option<JoinHandle<()>>>,
}

impl WorktreeCleanupRequests {
    /// Schedules a cleanup pass unless one waits to begin or the stop has begun; a scheduler that
    /// refuses it is logged, and the next request schedules again.
    pub(crate) fn request(&self) {
        let shared = &self.shared;
        if shared.is_stopping.load(Ordering::Acquire)
            || shared.is_requested.swap(true, Ordering::AcqRel)
        {
            return;
        }
        let cleanup = Arc::clone(shared);
        let scheduled = shared.scheduler.schedule(
            WORKTREE_CLEANUP_JOB_NAME,
            JobCondition::Always,
            Duration::ZERO,
            move |cancel| {
                let cleanup = Arc::clone(&cleanup);
                async move { cleanup.run_pass(&cancel).await }.boxed()
            },
        );
        if let Err(error) = scheduled {
            shared.is_requested.store(false, Ordering::Release);
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "the worktree cleanup could not be scheduled; the next request tries again"
            );
        }
    }

    // Requests a pass now and on each wake of the machine until the stop.
    fn start(&self) {
        let mut wakes = self.shared.scheduler.on_wake();
        let shared = Arc::downgrade(&self.shared);
        let wake_requests = tokio::spawn(async move {
            loop {
                match wakes.recv().await {
                    Ok(WakeSignal) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => return,
                }
                let Some(shared) = Weak::upgrade(&shared) else {
                    return;
                };
                Self { shared }.request();
            }
        });
        *lock(&self.shared.wake_requests) = Some(wake_requests);
        self.request();
    }

    // Ends the requests: none is made from now on, and the wake task ends. Answers that task's
    // failure when it panicked.
    async fn stop(&self) -> Option<TaskStopFailure> {
        self.shared.is_stopping.store(true, Ordering::Release);
        let wake_requests = lock(&self.shared.wake_requests).take()?;
        wake_requests.abort();
        match wake_requests.await {
            Err(error) if error.is_panic() => Some(TaskStopFailure {
                task: "worktree cleanup's wake requests",
                error,
            }),
            Ok(()) | Err(_) => None,
        }
    }
}

impl WorktreeCleanup {
    // One pass: puts right what a crash cut short, logging each failure, then sweeps the retired
    // trees, then forgets the setup card of each tree retired, whatever the sweep answered. Stops
    // between steps once `cancel` fires.
    async fn run_pass(&self, cancel: &CancellationToken) -> ScheduledJobOutcome {
        self.is_requested.store(false, Ordering::Release);
        let repair = self.removal.finish_interrupted_kept_copies(cancel).await;
        for failure in &repair.failures {
            tracing::warn!(
                error = failure as &(dyn Error + 'static),
                "a kept worktree's work a crash cut short could not be put right; the next \
                 cleanup tries again"
            );
        }
        let swept = if cancel.is_cancelled() {
            Ok(())
        } else {
            self.worktrees
                .cleanup_pass(&*self.removal, &self.owners, cancel)
                .await
                .map(drop)
        };
        self.setup.forget_retired().await;
        swept.map_err(Into::into)
    }
}

/// The workspace services' work at the start and its end at the stop: the finishing of the creates
/// and conversions a stop cut off, the worktree cleanup job's requests, and the kept worktrees'
/// background reads.
pub(crate) struct WorkspaceWork {
    creation: Arc<SessionCreation>,
    conversion: Arc<SessionConversion>,
    cleanup: WorktreeCleanupRequests,
    removed: Arc<RemovedWorktreeStore>,
    start_tasks: Vec<(&'static str, JoinHandle<()>)>,
}

impl WorkspaceWork {
    /// Begins in the background the finish of the creates and the removal of the copies a stop
    /// cut off, and the worktree cleanup, now and on each wake. Called once the start's recovery
    /// pass has ended.
    pub(crate) fn start(&mut self) {
        let creation = Arc::clone(&self.creation);
        self.start_tasks.push((
            "stopped creates' finish",
            tokio::spawn(async move {
                log_unfinished_creates(creation.finish_stopped_creates().await);
            }),
        ));
        let conversion = Arc::clone(&self.conversion);
        self.start_tasks.push((
            "stopped conversions' copy removal",
            tokio::spawn(async move {
                log_unremoved_copies(conversion.remove_stopped_copies().await);
            }),
        ));
        self.cleanup.start();
    }

    /// Ends the cleanup's requests, then waits within `bound` for the start's background tasks;
    /// one still running then is ended. Answers each task that ended abnormally or ran past the
    /// bound. Run before the scheduler stops.
    pub(crate) async fn stop(&mut self, bound: Duration) -> Vec<DaemonStopFailure> {
        let mut failures: Vec<DaemonStopFailure> = self
            .cleanup
            .stop()
            .await
            .into_iter()
            .map(Into::into)
            .collect();
        let deadline = tokio::time::Instant::now() + bound;
        for (task, mut handle) in self.start_tasks.drain(..) {
            match tokio::time::timeout_at(deadline, &mut handle).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => failures.push(TaskStopFailure { task, error }.into()),
                Err(_elapsed) => {
                    handle.abort();
                    failures.push(DaemonStopFailure::StartTaskRunning(task));
                }
            }
        }
        failures
    }

    /// Waits until no kept worktree's size read or deletion runs, so nothing writes once the stop
    /// resolves; run last.
    pub(crate) async fn settle(&self) {
        self.removed.settle().await;
    }
}

/// Settles the worktree creations a stop cut off, logging each failure, which the next start
/// tries again. Run once at the start before the socket serves, since a creation under way holds
/// the same kind of row.
pub(crate) async fn settle_interrupted_creations(creator: &WorktreeCreator) {
    for failure in creator.finish_interrupted_creations().await.failures {
        tracing::warn!(
            error = &failure as &(dyn Error + 'static),
            "a worktree a stop left mid-creation could not be settled; the next start tries again"
        );
    }
}

// Logs each session a stopped create could not be finished for.
fn log_unfinished_creates(finished: Result<(), SessionCreateError>) {
    let Err(error) = finished else {
        return;
    };
    if let SessionCreateError::Finish(failures) = error {
        for failure in each_failure(failures) {
            tracing::warn!(
                session_id = %failure.session_id,
                error = &failure as &(dyn Error + 'static),
                "a session a stop left being created could not be finished; its next start tries \
                 again"
            );
        }
    } else {
        tracing::warn!(
            error = &error as &(dyn Error + 'static),
            "the sessions a stop left being created could not be finished"
        );
    }
}

// Logs each session whose stopped conversion's copy could not be removed.
fn log_unremoved_copies(removed: Result<(), SessionConversionError>) {
    let Err(error) = removed else {
        return;
    };
    if let SessionConversionError::StoppedCopies(failures) = error {
        for failure in each_failure(failures) {
            tracing::warn!(
                session_id = %failure.session_id,
                error = &failure as &(dyn Error + 'static),
                "the copy a stopped conversion left could not be removed; its next start tries \
                 again"
            );
        }
    } else {
        tracing::warn!(
            error = &error as &(dyn Error + 'static),
            "the copies the stopped conversions left could not be removed"
        );
    }
}

// Every failure `failures` holds, in its order.
fn each_failure<Failure>(failures: SettleFailures<Failure>) -> Vec<Failure> {
    match failures {
        SettleFailures::One(failure) => vec![failure],
        SettleFailures::Many { failures, .. } => failures,
    }
}
