//! The worktree services the start builds: the reads a worktree's naming and setup take, the setup
//! card's runner, the live runs' folders and the worktree creator over them.

use std::sync::Arc;

use sidekicks_platforms::Spawner;
use sidekicks_provider::spawn_environment::ReservedEnvironmentNames;
use sidekicks_session::run::folders::SessionLiveRunFolders;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::DatabaseWriter;
use sidekicks_workspace::git::process::GitRunner;
use sidekicks_workspace::git::worktree::creation::{WorktreeCreator, WorktreeCreatorDeps};
use sidekicks_workspace::git::worktree::naming::WorktreeNaming;
use sidekicks_workspace::git::worktree::setup::{WorktreeSetupRunner, WorktreeSetupRunnerDeps};
use sidekicks_workspace::machine_settings::MachineSettingsReader;
use sidekicks_workspace::project::records::ProjectRecords;

use crate::daemon::process::repo_services::RepoServices;
use crate::daemon::process::worktree_sources::WorktreeSources;

/// What the worktree services are built from: the start's handles, lent, and the git and spawner the
/// services keep, owned.
pub(super) struct WorktreeServiceStart<'start> {
    /// The database's read pool.
    pub(super) reads: &'start Arc<DatabaseReadPool>,
    /// The database's writer, which a failed tree's mark goes through.
    pub(super) writer: &'start Arc<DatabaseWriter>,
    /// The repository services: the worktree rows, the folder watch, the tree's events, the
    /// worktrees' folder and the checkout lock.
    pub(super) repo: &'start RepoServices,
    /// The project records.
    pub(super) records: &'start Arc<ProjectRecords>,
    /// The machine's settings.
    pub(super) settings: &'start Arc<dyn MachineSettingsReader>,
    /// The login shell's environment captured at the start.
    pub(super) base_environment: &'start Arc<[(String, String)]>,
    /// The names no environment row may set.
    pub(super) reserved_names: &'start Arc<ReservedEnvironmentNames>,
    /// The daemon's git.
    pub(super) git: GitRunner,
    /// The thread every setup command is started from.
    pub(super) spawner: Spawner,
}

/// The worktree services the start hands on.
pub(super) struct WorktreeServices {
    /// The setup card's runner.
    pub(super) setup: Arc<WorktreeSetupRunner>,
    /// The folders runs are live in, which the creator reads and the execution roots take.
    pub(super) live_run_folders: Arc<SessionLiveRunFolders>,
    /// The worktree creator.
    pub(super) creator: Arc<WorktreeCreator>,
}

/// Builds the worktree services from `start`: the setup runner and the creator share one set of
/// the naming's and setup's reads.
pub(super) fn build_worktree_services(start: WorktreeServiceStart<'_>) -> WorktreeServices {
    let WorktreeServiceStart {
        reads,
        writer,
        repo,
        records,
        settings,
        base_environment,
        reserved_names,
        git,
        spawner,
    } = start;
    let worktree_sources = Arc::new(WorktreeSources {
        reads: Arc::clone(reads),
        records: Arc::clone(records),
        worktrees: Arc::clone(&repo.worktrees),
        settings: Arc::clone(settings),
        base_environment: Arc::clone(base_environment),
        reserved_names: Arc::clone(reserved_names),
    });
    let setup = Arc::new(WorktreeSetupRunner::new(WorktreeSetupRunnerDeps {
        git: git.clone(),
        spawner,
        watcher: Arc::clone(&repo.folder_watch),
        sources: Arc::clone(&worktree_sources) as _,
    }));
    let live_run_folders = Arc::new(SessionLiveRunFolders::new(Arc::clone(reads)));
    let creator = Arc::new(WorktreeCreator::new(WorktreeCreatorDeps {
        git,
        reads: Arc::clone(reads),
        writer: Arc::clone(writer),
        events: Arc::clone(&repo.worktree_events),
        naming: WorktreeNaming::new(repo.worktrees_folder.clone(), worktree_sources),
        worktrees: Arc::clone(&repo.worktrees),
        setup: Arc::clone(&setup),
        live_run_folders: Arc::clone(&live_run_folders) as _,
        checkout_lock: Arc::clone(&repo.checkout_lock),
    }));
    WorktreeServices {
        setup,
        live_run_folders,
        creator,
    }
}
