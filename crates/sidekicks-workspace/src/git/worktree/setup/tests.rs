use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, BufRead as _, BufReader, Read as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use WorktreeSetupStepState::{Failed, Pending, Succeeded};
use futures::FutureExt as _;
use futures::future::BoxFuture;
use notify::NullWatcher;
use rstest::rstest;
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
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log};
use tempfile::TempDir;

use super::steps::OUTPUT_LINGER;
use super::{
    MadeWorktree, WorktreeSetupError, WorktreeSetupRunner, WorktreeSetupRunnerDeps,
    WorktreeSetupSources,
};
use crate::git::process::{GitCall, GitRunner, in_folder, test_git_runner};
use crate::git::worktree::event_emitter::WorktreeEventEmitter;
use crate::git::worktree::occupancy::MountOccupancyReader;
use crate::git::worktree::schema::schema_parts;
use crate::git::worktree::watch::{WorkingFolderWatcher, WorkingFolderWatcherDeps};

const READ_STATEMENT_CAPACITY: usize = 16;

#[expect(
    clippy::unnecessary_wraps,
    reason = "it stands in for the machine's ceiling read, which can fail"
)]
fn no_ceiling() -> io::Result<Option<u64>> {
    Ok(None)
}

// The project's setup as the test saves it, read again at each read; a read refused while
// `is_unreadable` is set, as a settings file that cannot be read refuses one.
struct SavedSetup {
    setup: Mutex<ProjectSetup>,
    is_unreadable: AtomicBool,
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
        let setup = lock(&self.setup).clone();
        let is_unreadable = self.is_unreadable.load(Ordering::SeqCst);
        async move {
            if is_unreadable {
                return Err(WorktreeSetupError::Read(
                    io::Error::new(io::ErrorKind::InvalidData, "the settings file is not JSON")
                        .into(),
                ));
            }
            Ok(setup)
        }
        .boxed()
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
    sources: Arc<SavedSetup>,
    runner: WorktreeSetupRunner<NullWatcher>,
}

impl SetupFixture {
    async fn new(setup: ProjectSetup) -> Self {
        let database = TestDatabase::new(schema_parts());
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
                    tokio::sync::watch::channel(0).1,
                )),
                read_watch_ceiling: no_ceiling,
                slow_tick_interval: Duration::from_secs(180),
            },
        ));
        let sources = Arc::new(SavedSetup {
            setup: Mutex::new(setup),
            is_unreadable: AtomicBool::new(false),
        });
        let runner = WorktreeSetupRunner::new(WorktreeSetupRunnerDeps {
            git,
            spawner: Spawner::new(tokio::runtime::Handle::current())
                .expect("the spawner thread starts"),
            watcher,
            sources: Arc::clone(&sources) as _,
            command_shell: command_shell().expect("the account's shell reads"),
        });
        Self {
            scratch,
            _database: database,
            _log: log,
            sources,
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
                hook_output: None,
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

// Kills a failed re-read that drops the record of the steps that succeeded, so the next good
// retry runs a command that already ran once more.
#[tokio::test]
async fn a_retry_whose_read_fails_keeps_the_succeeded_steps_for_the_next_read() {
    let fixture = SetupFixture::new(setup_of(
        &[],
        &["echo ran >> ran.log", "test -f fixed"],
        None,
    ))
    .await;
    let tree = fixture.tree();
    let (worktree_id, failed) = fixture.make().await;
    assert_eq!(states_of(&failed), [Succeeded, Succeeded, Failed, Pending]);

    fixture.sources.is_unreadable.store(true, Ordering::SeqCst);
    let unread = fixture
        .runner
        .retry(worktree_id)
        .await
        .expect("the retry answers the card");

    assert_eq!(unread.state, WorktreeSetupState::Failed);
    assert_eq!(states_of(&unread), [Succeeded, Failed]);
    assert_eq!(
        unread.steps[1].error.as_ref().map(FreeFormText::as_str),
        Some(
            "Could not read the setup steps: the setup's records could not be read: the settings \
             file is not JSON"
        )
    );

    fixture.sources.is_unreadable.store(false, Ordering::SeqCst);
    fs::write(tree.join("fixed"), "").expect("written");
    let retried = fixture
        .runner
        .retry(worktree_id)
        .await
        .expect("the retry runs");

    assert_eq!(retried.state, WorktreeSetupState::Succeeded);
    assert_eq!(states_of(&retried), [Succeeded; 4]);
    assert_eq!(
        fs::read_to_string(tree.join("ran.log")).expect("the tree's file reads"),
        "ran\n",
        "a step that succeeded before the failed read is not run again"
    );
}

// Makes the named pipe `name` in the tree, through which a command's processes tell the test what
// they did: the test reads what they write, and the pipe's close once every holder has ended.
fn make_named_pipe(fixture: &SetupFixture, name: &str) -> PathBuf {
    let path = fixture.tree().join(name);
    let made = std::process::Command::new("mkfifo")
        .arg(&path)
        .status()
        .expect("mkfifo runs");
    assert!(made.success(), "the named pipe is made");
    path
}

// Opens the named pipe for reading, which waits for a writer, and reads its first line, keeping
// the pipe open. It runs as blocking work, so a paused clock stands still until the line arrives.
async fn read_first_line(path: PathBuf) -> (String, BufReader<File>) {
    tokio::task::spawn_blocking(move || {
        let mut reader = BufReader::new(File::open(path).expect("the named pipe opens"));
        let mut line = String::new();
        reader.read_line(&mut line).expect("the named pipe reads");
        (line, reader)
    })
    .await
    .expect("the read finishes")
}

// Reads the named pipe until every process holding it open has closed it; a process that outlives
// its end keeps this waiting until the runner gives up.
async fn read_until_closed(mut reader: BufReader<File>) -> String {
    tokio::task::spawn_blocking(move || {
        let mut rest = String::new();
        reader
            .read_to_string(&mut rest)
            .expect("the named pipe reads");
        rest
    })
    .await
    .expect("the read finishes")
}

// Kills a time limit that leaves a process the command started running, and a time-limit failure
// that drops its tail.
#[tokio::test]
async fn a_command_past_its_time_limit_is_ended_with_every_process_it_started() {
    let fixture = SetupFixture::new(setup_of(
        &[],
        &["exec 3>held; sleep 300 & echo last; echo started >&3; wait"],
        Some(1),
    ))
    .await;
    let held = make_named_pipe(&fixture, "held");
    // The limit's clock stands still while the test waits for the command to print and start its
    // process, then jumps, so no load can end the command before either.
    tokio::time::pause();

    let ((_, failed), (started, held)) = tokio::join!(fixture.make(), read_first_line(held));

    assert_eq!(started, "started\n");
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
    assert_eq!(
        read_until_closed(held).await,
        "",
        "a process the command started outlived its end"
    );
}

// How far the test moves a paused clock at a time, and how long it waits in real time between two
// moves, so the step sees each move before the next.
const CLOCK_TICK: Duration = Duration::from_millis(1);

// Moves the paused clock a tick at a time until every process holding the named pipe `reader`
// reads has closed it, and answers what was read meanwhile. Fails once it has moved the clock
// twice the linger. The read runs on a thread of its own, outside the runtime, so it never holds
// the clock still and never waits on a tick.
async fn move_clock_until_closed(mut reader: BufReader<File>) -> String {
    let (read_sender, read) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let mut rest = String::new();
        let read = reader.read_to_string(&mut rest).map(|_| rest);
        // The test may have failed and dropped the receiver; nothing then waits for the read.
        let _unread = read_sender.send(read);
    });
    tokio::pin!(read);
    let mut moved = Duration::ZERO;
    loop {
        tokio::select! {
            biased;
            rest = &mut read => {
                return rest
                    .expect("the read's thread answers")
                    .expect("the named pipe reads");
            }
            paced = tokio::task::spawn_blocking(|| std::thread::sleep(CLOCK_TICK)) => {
                paced.expect("the pause finishes");
                // Once for the output and once after what the command left running is ended.
                assert!(
                    moved < 2 * OUTPUT_LINGER,
                    "the step waited past twice the linger for the output"
                );
                tokio::time::advance(CLOCK_TICK).await;
                moved += CLOCK_TICK;
            }
        }
    }
}

// Kills the wait for the output left unbounded or longer than the linger after the command exits,
// which a process it left running holds open, and that process left running once the step ends,
// whether it holds the output or closed it. The clock is paused and held still for the whole
// setup, so it moves only as the test moves it once the command has started its process: the
// step's time is then the linger's alone, and the git status after the step never times out.
#[rstest]
#[case::holding_the_output("exec 3>held; sleep 300 & echo started >&3")]
#[case::output_closed("exec 3>held; sleep 300 > /dev/null 2>&1 & echo started >&3")]
#[tokio::test]
async fn a_command_that_leaves_a_process_running_succeeds_within_the_linger(#[case] line: &str) {
    let fixture = SetupFixture::new(setup_of(&[], &[line], None)).await;
    let held = make_named_pipe(&fixture, "held");
    tokio::time::pause();
    // A blocking wait alive stops the paused clock from jumping to the next timer on its own.
    let (end_hold, hold_ended) = mpsc::channel::<()>();
    let hold = tokio::task::spawn_blocking(move || hold_ended.recv());

    let ((_, succeeded), (started, rest)) = tokio::join!(
        async {
            let made = fixture.make().await;
            end_hold.send(()).expect("the clock's hold waits");
            made
        },
        async {
            let (started, held) = read_first_line(held).await;
            (started, move_clock_until_closed(held).await)
        }
    );

    hold.await
        .expect("the hold finishes")
        .expect("the hold is ended");
    assert_eq!(started, "started\n");
    assert_eq!(succeeded.state, WorktreeSetupState::Succeeded);
    assert_eq!(rest, "", "the process the command left running was ended");
}

// Lets the process that left the tree write to the output it still holds, then answers the status
// that write ended with, which its last line prints into `wrote`.
fn let_escaped_process_write(go: &Path, wrote: &Path) -> io::Result<String> {
    fs::write(go, "go\n")?;
    let mut status = String::new();
    BufReader::new(File::open(wrote)?).read_line(&mut status)?;
    Ok(status)
}

// Lets the process that left the tree run to its end when the test fails before letting it, so it
// never stays waiting on `go` for good: it lives outside the command's group, so nothing else ends
// it.
struct EscapedProcessRelease {
    // `go` and `wrote`, until the test lets the process write.
    pipes: Option<(PathBuf, PathBuf)>,
}

impl Drop for EscapedProcessRelease {
    fn drop(&mut self) {
        if let Some((go, wrote)) = self.pipes.take() {
            // The test is already failing; this only frees the process, so its status is no
            // longer read.
            let _status = let_escaped_process_write(&go, &wrote);
        }
    }
}

// Kills the output read on a thread that stays waiting on the pipe after the step ends: a process
// that left the command's tree and still holds the output writes once the step has ended, and
// that write must fail on the closed pipe. The command ends only once the process has left its
// tree, and the process writes only once the test lets it.
#[tokio::test]
async fn a_process_that_left_the_tree_cannot_write_to_the_output_after_the_step() {
    let fixture = SetupFixture::new(setup_of(
        &[],
        &["perl -MPOSIX -e 'setsid; exec @ARGV' sh -c \
           'echo > left; read go < go; (echo late); echo $? > wrote' & read left < left"],
        None,
    ))
    .await;
    make_named_pipe(&fixture, "left");
    let go = make_named_pipe(&fixture, "go");
    let wrote = make_named_pipe(&fixture, "wrote");

    let (_, succeeded) = fixture.make().await;
    // Armed once the step has ended, by which time the process has left the tree and waits on
    // `go`; before, it may not exist, and the release would wait on `go` for good.
    let mut release = EscapedProcessRelease {
        pipes: Some((go, wrote)),
    };

    assert_eq!(succeeded.state, WorktreeSetupState::Succeeded);
    let (go, wrote) = release.pipes.take().expect("the process is not let go yet");
    let status = tokio::task::spawn_blocking(move || let_escaped_process_write(&go, &wrote))
        .await
        .expect("the write finishes")
        .expect("the process is let write and its status read");
    assert_ne!(
        status.trim(),
        "0",
        "the process that left the tree wrote to an output still read"
    );
}
