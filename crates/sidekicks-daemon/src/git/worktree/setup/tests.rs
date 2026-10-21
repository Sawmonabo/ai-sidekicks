use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use notify::NullWatcher;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::project::ProjectSetup;
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::BoundedInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_contracts::worktree::lifecycle::WorktreeId;
use sidekicks_contracts::worktree::setup::{
    WorktreeSetupStage, WorktreeSetupState, WorktreeSetupStatus, WorktreeSetupStepState,
};
use sidekicks_platforms::{Spawner, WallClockTimer, command_shell};
use tempfile::TempDir;

use WorktreeSetupStepState::{Failed, Pending, Succeeded};

use super::{
    MadeWorktree, WorktreeSetupError, WorktreeSetupRunner, WorktreeSetupRunnerDeps,
    WorktreeSetupSources,
};
use crate::daemon::scheduler::Scheduler;
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::TestDatabase;
use crate::events::log_service::tests::{TestLog, open_log};
use crate::git::process::{GitCall, GitRunner, in_folder, test_git_runner};
use crate::git::worktree::event_emitter::WorktreeEventEmitter;
use crate::git::worktree::occupancy::MountOccupancyReader;
use crate::git::worktree::watch::{WorkingFolderWatcher, WorkingFolderWatcherDeps};

const READ_STATEMENT_CAPACITY: usize = 16;

#[expect(
    clippy::unnecessary_wraps,
    reason = "it stands in for the machine's ceiling read, which can fail"
)]
fn no_ceiling() -> io::Result<Option<u64>> {
    Ok(None)
}

// The project's setup as the test saves it, read again at each read.
struct SavedSetup {
    setup: Mutex<ProjectSetup>,
}

impl WorktreeSetupSources for SavedSetup {
    fn require_worktree<'a>(
        &'a self,
        _worktree_id: &'a WorktreeId,
    ) -> BoxFuture<'a, Result<(), WorktreeSetupError>> {
        async { Ok(()) }.boxed()
    }

    fn read_retired<'a>(
        &'a self,
        _worktree_ids: &'a [WorktreeId],
    ) -> BoxFuture<'a, Result<HashSet<WorktreeId>, WorktreeSetupError>> {
        async { Ok(HashSet::new()) }.boxed()
    }

    fn read_project_setup<'a>(
        &'a self,
        _worktree_id: &'a WorktreeId,
    ) -> BoxFuture<'a, Result<ProjectSetup, WorktreeSetupError>> {
        let setup = self
            .setup
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        async move { Ok(setup) }.boxed()
    }

    fn read_command_environment<'a>(
        &'a self,
        _worktree_id: &'a WorktreeId,
    ) -> BoxFuture<'a, Result<Vec<(String, String)>, WorktreeSetupError>> {
        async { Ok(std::env::vars().collect()) }.boxed()
    }
}

// A repository's checkout and a tree linked to it, and a runner over them.
struct SetupFixture {
    scratch: TempDir,
    // Held for the runner's watcher, whose events it writes.
    _database: TestDatabase,
    _log: TestLog,
    runner: WorktreeSetupRunner<NullWatcher>,
}

impl SetupFixture {
    async fn new(setup: ProjectSetup) -> Self {
        let database = TestDatabase::new();
        let log = open_log(&database, None).await;
        let reads = Arc::new(DatabaseReadPool::new(
            database.path(),
            READ_STATEMENT_CAPACITY,
        ));
        let git = test_git_runner();
        let scratch = tempfile::tempdir().expect("a scratch folder");
        git_in(
            &git,
            scratch.path(),
            &["init", "--quiet", "--initial-branch=main", "app"],
        )
        .await;
        let checkout = scratch.path().join("app");
        git_in(
            &git,
            &checkout,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "commit.gpgSign=false",
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                "first",
            ],
        )
        .await;
        let tree = scratch.path().join("tree");
        git_in(
            &git,
            &checkout,
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                "tree",
                &tree.to_string_lossy(),
            ],
        )
        .await;
        let watcher = Arc::new(WorkingFolderWatcher::<NullWatcher>::new(
            WorkingFolderWatcherDeps {
                git: git.clone(),
                reads: Arc::clone(&reads),
                occupancy: MountOccupancyReader::new(reads),
                events: Arc::new(WorktreeEventEmitter::new(Arc::clone(&log.service))),
                scheduler: Arc::new(Scheduler::start(
                    Arc::new(WallClockTimer::new().expect("the wall-clock timer is made")),
                    None,
                )),
                read_watch_ceiling: no_ceiling,
                slow_tick_interval: Duration::from_secs(180),
            },
        ));
        let runner = WorktreeSetupRunner::new(WorktreeSetupRunnerDeps {
            git,
            spawner: Spawner::new(tokio::runtime::Handle::current())
                .expect("the spawner thread starts"),
            watcher,
            sources: Arc::new(SavedSetup {
                setup: Mutex::new(setup),
            }),
            command_shell: command_shell().expect("the account's shell reads"),
        });
        Self {
            scratch,
            _database: database,
            _log: log,
            runner,
        }
    }

    fn checkout(&self) -> std::path::PathBuf {
        self.scratch.path().join("app")
    }

    fn tree(&self) -> std::path::PathBuf {
        self.scratch.path().join("tree")
    }

    async fn make(&self) -> (WorktreeId, WorktreeSetupStatus) {
        let worktree_id =
            WorktreeId::new(&mint_uuid_v7().to_string()).expect("a minted id is a worktree id");
        self.runner.begin(worktree_id);
        let status = self
            .runner
            .tree_made(MadeWorktree {
                worktree_id,
                tree_path: self.tree(),
                repository_root: self.checkout(),
                repo_mount_id: RepoMountId::new(&mint_uuid_v7().to_string())
                    .expect("a minted id is a mount id"),
                place: None,
            })
            .await
            .expect("the setup runs");
        (worktree_id, status)
    }
}

async fn git_in(git: &GitRunner, folder: &Path, arguments: &[&str]) {
    git.run(None, GitCall::read(in_folder(folder, arguments)))
        .await
        .expect("git runs in the test repository");
}

fn setup_of(
    files_to_copy: &[&str],
    commands: &[&str],
    time_limit_seconds: Option<i64>,
) -> ProjectSetup {
    ProjectSetup {
        files_to_copy: files_to_copy
            .iter()
            .map(|path| FilesystemPath::new((*path).to_owned()).expect("a test path is a path"))
            .collect(),
        commands: commands
            .iter()
            .map(|line| FreeFormText::new((*line).to_owned()).expect("a test command is text"))
            .collect(),
        time_limit_seconds: time_limit_seconds
            .map(|seconds| BoundedInt::new(seconds).expect("a test limit is in range")),
    }
}

fn states_of(status: &WorktreeSetupStatus) -> Vec<WorktreeSetupStepState> {
    status.steps.iter().map(|step| step.state).collect()
}

#[tokio::test]
async fn a_failed_command_stops_the_run_and_a_retry_runs_on_from_it_keeping_the_tree_s_files() {
    let fixture = SetupFixture::new(setup_of(
        &["config.txt", "settings"],
        &["echo ran >> ran.log", "test -f fixed"],
        None,
    ))
    .await;
    let checkout = fixture.checkout();
    let tree = fixture.tree();
    fs::write(checkout.join("config.txt"), "the repository's").expect("written");
    fs::create_dir(checkout.join("settings")).expect("made");
    fs::write(checkout.join("settings/a.txt"), "the repository's a").expect("written");
    fs::write(checkout.join("settings/b.txt"), "the repository's b").expect("written");
    fs::write(tree.join("config.txt"), "the tree's own").expect("written");
    fs::create_dir(tree.join("settings")).expect("made");
    fs::write(tree.join("settings/a.txt"), "the tree's own a").expect("written");

    let (worktree_id, failed) = fixture.make().await;

    assert_eq!(failed.state, WorktreeSetupState::Failed);
    assert_eq!(
        states_of(&failed),
        [Succeeded, Succeeded, Succeeded, Succeeded, Failed, Pending]
    );
    assert_eq!(
        failed.steps[4].error.as_ref().map(FreeFormText::as_str),
        Some("Exited with code 1")
    );
    let read = |path: &str| fs::read_to_string(tree.join(path)).expect("the tree's file reads");
    assert_eq!(read("config.txt"), "the tree's own");
    assert_eq!(read("settings/a.txt"), "the tree's own a");
    assert_eq!(read("settings/b.txt"), "the repository's b");

    fs::write(tree.join("fixed"), "").expect("written");
    let retried = fixture
        .runner
        .retry(worktree_id)
        .await
        .expect("the retry runs");

    assert_eq!(retried.state, WorktreeSetupState::Succeeded);
    assert_eq!(states_of(&retried), [Succeeded; 6]);
    assert_eq!(
        retried.steps.last().map(|step| step.stage),
        Some(WorktreeSetupStage::WarmCaches)
    );
    assert_eq!(
        read("ran.log"),
        "ran\n",
        "a step that succeeded is not run again"
    );
}

// Kills a time limit that leaves a process the command started running, and the tail taken
// without waiting for the output that came before the end.
#[tokio::test]
async fn a_command_past_its_time_limit_is_ended_with_every_process_it_started() {
    let fixture = SetupFixture::new(setup_of(
        &[],
        &["(sleep 2; touch outlived) & sleep 0.8; echo last; wait"],
        Some(1),
    ))
    .await;

    let (_, failed) = fixture.make().await;

    assert_eq!(failed.state, WorktreeSetupState::Failed);
    assert_eq!(
        failed.steps[1].error.as_ref().map(FreeFormText::as_str),
        Some("Gave up after 1 second")
    );
    assert!(
        failed.steps[1]
            .output
            .as_ref()
            .is_some_and(|tail| tail.as_str().contains("last")),
        "the tail holds the last line written before the end"
    );
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(
        !fixture.tree().join("outlived").exists(),
        "a process the command started outlived its end"
    );
}

// Kills the wait for the output left unbounded after the command exits, which a process it left
// running holds open, and that process left running once the step ends.
#[tokio::test]
async fn a_command_that_leaves_a_process_running_succeeds_within_the_linger() {
    let fixture = SetupFixture::new(setup_of(&[], &["(sleep 5; touch outlived) &"], None)).await;
    let started = tokio::time::Instant::now();

    let (_, succeeded) = fixture.make().await;

    assert_eq!(succeeded.state, WorktreeSetupState::Succeeded);
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "the step ends within the linger, not when the process exits"
    );
    tokio::time::sleep_until(started + Duration::from_secs(6)).await;
    assert!(
        !fixture.tree().join("outlived").exists(),
        "the process the command left running was ended"
    );
}
