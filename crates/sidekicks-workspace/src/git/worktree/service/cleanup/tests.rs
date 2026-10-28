use std::error::Error;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use futures::future::BoxFuture;
use rstest::rstest;
use rusqlite::{Connection, params};
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::worktree::lifecycle::{WorktreeId, WorktreeState};
use sidekicks_std::settle_all::SettleFailures;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log};
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

use super::{
    RetiredWorktreeKeeper, WorktreeCleanupError, WorktreeCleanupFailure, is_nothing_to_stop,
    stop_file_watch,
};
use crate::git::process::test_repository::{git_in, make_test_repository};
use crate::git::process::{
    GitCall, GitError, GitRunner, StartedFileWatch, find_git_executable, in_folder,
    test_git_runner, test_git_runner_with_environment,
};
use crate::git::worktree::event_emitter::WorktreeEventEmitter;
use crate::git::worktree::occupancy::MountOccupancyReader;
use crate::git::worktree::removal::FolderProcessOwner;
use crate::git::worktree::removal::test_owner::{FolderSighting, RecordingOwner};
use crate::git::worktree::rows::WorktreeRow;
use crate::git::worktree::schema::schema_parts;
use crate::git::worktree::service::{WorktreeService, WorktreeServiceDeps};
use crate::git::worktree::test_rows::store_run_inside;
use crate::test_rows::{PARENT_ROWS_AT, project_and_mount_rows};

const READ_STATEMENT_CAPACITY: usize = 16;

// A keeper that records which trees it was asked to keep aside and, at each, what `owner` had
// been asked and had released by then.
#[derive(Default)]
struct RecordingKeeper {
    kept: Mutex<Vec<WorktreeId>>,
    owner: Arc<RecordingOwner>,
    owner_at_keep: Mutex<Vec<(Vec<FolderSighting>, Vec<FolderSighting>)>>,
}

impl RetiredWorktreeKeeper for RecordingKeeper {
    fn keep_retired_aside<'a>(
        &'a self,
        row: &'a WorktreeRow,
    ) -> BoxFuture<'a, Result<(), Box<dyn Error + Send + Sync>>> {
        Box::pin(async move {
            self.kept.lock().expect("the keeper's list").push(row.id);
            self.owner_at_keep
                .lock()
                .expect("the keeper's list")
                .push((self.owner.asked(), self.owner.released()));
            Ok(())
        })
    }
}

fn new_id() -> String {
    mint_uuid_v7().to_string()
}

// A retired tree's row at `folder` on `mount`, made by a session of its own.
fn store_retired_tree(connection: &Connection, mount: &str, folder: &Path) -> WorktreeId {
    let worktree_id = new_id();
    connection
        .execute(
            "INSERT INTO worktrees (id, repo_mount_id, created_by_session_id, branch_name, \
             base_ref, fs_root, state, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, 'main', ?5, ?6, ?7, ?7)",
            params![
                worktree_id,
                mount,
                new_id(),
                folder.file_name().map(|name| name.to_string_lossy()),
                folder.to_string_lossy(),
                <&'static str>::from(WorktreeState::Retired),
                PARENT_ROWS_AT,
            ],
        )
        .expect("the worktree is stored");
    WorktreeId::new(&worktree_id).expect("a minted id is a worktree id")
}

fn cleaned_at(connection: &Connection, worktree_id: &WorktreeId) -> Option<String> {
    connection
        .query_row(
            "SELECT cleaned_at FROM worktrees WHERE id = ?1",
            [worktree_id.to_string()],
            |row| row.get(0),
        )
        .expect("the worktree's row is read")
}

// A repository `app` with one commit its remote-tracking branch also holds, so no tree has
// unpushed work, its mount, and the service over them, cleaning trees under `worktrees`.
struct CleanupFixture {
    database: TestDatabase,
    _log: TestLog,
    scratch: TempDir,
    git: GitRunner,
    repository: PathBuf,
    worktrees_folder: PathBuf,
    mount: String,
    service: WorktreeService,
}

impl CleanupFixture {
    async fn new(git: GitRunner) -> Self {
        let database = TestDatabase::new(schema_parts());
        let log = open_log(&database, None).await;
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let repository = make_test_repository(&git, scratch.path(), "app").await;
        git_in(
            &git,
            &repository,
            &["update-ref", "refs/remotes/origin/main", "HEAD"],
        )
        .await;
        let worktrees_folder = scratch.path().join("worktrees");
        let mount = new_id();
        let connection = database.reader();
        for row in project_and_mount_rows(&mount, None) {
            connection
                .execute_batch(&row)
                .expect("the project and its mount are stored");
        }
        connection
            .execute(
                "UPDATE repo_mounts SET canonical_root = ?1 WHERE id = ?2",
                params![repository.to_string_lossy(), mount],
            )
            .expect("the mount points at the repository");
        let reads = Arc::new(DatabaseReadPool::new(
            database.path(),
            READ_STATEMENT_CAPACITY,
        ));
        let service = WorktreeService::new(WorktreeServiceDeps {
            git: git.clone(),
            reads: Arc::clone(&reads),
            writer: Arc::clone(&log.writer),
            events: Arc::new(WorktreeEventEmitter::new(Arc::clone(&log.service))),
            occupancy: MountOccupancyReader::new(reads),
            worktrees_folder: worktrees_folder.clone(),
        });
        Self {
            database,
            _log: log,
            scratch,
            git,
            repository,
            worktrees_folder,
            mount,
            service,
        }
    }

    fn tree_at(&self, name: &str) -> PathBuf {
        self.worktrees_folder.join("app").join(name)
    }

    // A linked tree on a new branch `name`, at its named folder.
    async fn add_tree(&self, name: &str) -> PathBuf {
        let folder = self.tree_at(name);
        git_in(
            &self.git,
            &self.repository,
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                name,
                &folder.to_string_lossy(),
            ],
        )
        .await;
        folder
    }
}

// Kills: a removal while an agent runs in the tree, a folder holding new work deleted rather than
// kept aside, and a pass that stops at its first failure.
#[tokio::test]
async fn a_pass_defers_a_tree_in_use_keeps_new_work_aside_and_reports_every_failure() {
    let fixture = CleanupFixture::new(test_git_runner()).await;
    let (repository, worktrees_folder, mount) = (
        &fixture.repository,
        &fixture.worktrees_folder,
        &fixture.mount,
    );
    let tree_at = |name: &str| fixture.tree_at(name);
    for name in ["busy", "clean", "kept"] {
        fixture.add_tree(name).await;
    }
    std::fs::write(tree_at("kept").join("new.txt"), "new work\n").expect("the new work is written");
    let connection = fixture.database.reader();
    let busy = store_retired_tree(&connection, mount, &tree_at("busy"));
    let clean = store_retired_tree(&connection, mount, &tree_at("clean"));
    let kept = store_retired_tree(&connection, mount, &tree_at("kept"));
    let outside = [
        store_retired_tree(
            &connection,
            mount,
            &fixture.scratch.path().join("elsewhere"),
        ),
        store_retired_tree(&connection, mount, &worktrees_folder.join("app")),
    ];
    let run_id = store_run_inside(&connection, mount, repository, &tree_at("busy"));
    let service = &fixture.service;
    let keeper = RecordingKeeper::default();

    let first = service
        .cleanup_pass(&keeper, &[], &CancellationToken::new())
        .await;

    let Err(SettleFailures::Many { failures, .. }) = first else {
        panic!("both trees outside a named folder fail the pass together, got {first:?}");
    };
    let mut failed: Vec<WorktreeId> = failures
        .iter()
        .map(|failure| match failure {
            WorktreeCleanupFailure::Tree {
                worktree_id,
                cause: WorktreeCleanupError::UnnamedFolder,
            } => *worktree_id,
            other @ (WorktreeCleanupFailure::Rows(_) | WorktreeCleanupFailure::Tree { .. }) => {
                panic!("only the unnamed folders fail, got {other:?}")
            }
        })
        .collect();
    failed.sort_by_key(ToString::to_string);
    let mut expected_failed = outside.to_vec();
    expected_failed.sort_by_key(ToString::to_string);
    assert_eq!(failed, expected_failed);
    assert!(
        tree_at("busy").exists(),
        "a tree an agent runs in keeps its folder"
    );
    assert_eq!(cleaned_at(&connection, &busy), None);
    assert!(
        !tree_at("clean").exists(),
        "a tree with nothing to lose is removed"
    );
    assert!(
        !repository.join(".git/worktrees/clean").exists(),
        "its git record is removed with it"
    );
    assert!(cleaned_at(&connection, &clean).is_some());
    assert!(
        tree_at("kept").join("new.txt").exists(),
        "new work is never deleted"
    );
    assert_eq!(*keeper.kept.lock().expect("the keeper's list"), [kept]);

    // Once the run ends, the deferred tree is cleaned on the next pass.
    connection
        .execute(
            "UPDATE run_execution_contexts SET released_at = ?1 WHERE run_id = ?2",
            params![PARENT_ROWS_AT, run_id],
        )
        .expect("the run is released");
    for worktree_id in &outside {
        connection
            .execute(
                "UPDATE worktrees SET cleaned_at = ?1 WHERE id = ?2",
                params![PARENT_ROWS_AT, worktree_id.to_string()],
            )
            .expect("the unnamed folders are settled");
    }
    let second = service
        .cleanup_pass(&keeper, &[], &CancellationToken::new())
        .await
        .expect("the second pass succeeds");
    assert_eq!(second.cleaned, [busy]);
    assert_eq!(second.kept, [kept]);
    assert!(!tree_at("busy").exists());
}

// Kills ending a tree's processes after it is kept aside or deleted, and dropping their hold
// before either lands, which lets a process start in the tree again first.
#[tokio::test]
async fn a_pass_ends_a_tree_s_processes_before_keeping_or_deleting_it() {
    let fixture = CleanupFixture::new(test_git_runner()).await;
    let clean = fixture.add_tree("clean").await;
    let kept = fixture.add_tree("kept").await;
    std::fs::write(kept.join("new.txt"), "new work\n").expect("the new work is written");
    let connection = fixture.database.reader();
    store_retired_tree(&connection, &fixture.mount, &clean);
    store_retired_tree(&connection, &fixture.mount, &kept);
    let keeper = RecordingKeeper::default();
    let owners = [Arc::clone(&keeper.owner) as Arc<dyn FolderProcessOwner>];

    fixture
        .service
        .cleanup_pass(&keeper, &owners, &CancellationToken::new())
        .await
        .expect("the pass succeeds");

    let in_place = |folder: &Path| FolderSighting {
        folder: folder.to_path_buf(),
        was_present: true,
    };
    let [(asked, released)] = &keeper.owner_at_keep.lock().expect("the keeper's list")[..] else {
        panic!("one tree is kept aside");
    };
    assert!(
        asked.contains(&in_place(&kept)),
        "the owner is asked for the kept tree before it is kept aside"
    );
    assert!(
        released.iter().all(|sighting| sighting.folder != kept),
        "the kept tree's hold stands while it is kept aside"
    );
    assert!(
        keeper.owner.asked().contains(&in_place(&clean)),
        "the owner is asked for the clean tree while it is in place"
    );
    assert!(
        keeper.owner.released().contains(&FolderSighting {
            folder: clean,
            was_present: false,
        }),
        "the clean tree's hold drops only once its folder is deleted"
    );
}

// Kills a refusal read by its prefix alone, a line that is not the last `fatal:` line read, any
// other failure of the stop read as nothing to stop, and a failed check or a remote repository put
// back among the refusals, since a daemon started before either can still be running.
#[rstest]
#[case::not_running("fatal: fsmonitor--daemon is not running\n", true)]
#[case::bare("fatal: bare repository '/r' is incompatible with fsmonitor\n", true)]
#[case::virtual_repository(
    "fatal: virtual repository '/r' is incompatible with fsmonitor\n",
    true
)]
#[case::no_sockets(
    "fatal: socket directory '/r/.git' is incompatible with fsmonitor due to lack of Unix sockets \
     support\n",
    true
)]
#[case::check_failed(
    "fatal: repository '/r' is incompatible with fsmonitor due to errors\n",
    false
)]
#[case::remote(
    "fatal: remote repository '/r' is incompatible with fsmonitor\n",
    false
)]
#[case::other_words_after_the_folder("fatal: bare repository '/r' is not reachable\n", false)]
#[case::earlier_line(
    "fatal: fsmonitor--daemon is not running\nfatal: could not send the stop\n",
    false
)]
#[case::unsupported("fatal: fsmonitor--daemon not supported on this platform\n", false)]
fn a_stop_with_no_daemon_to_stop_is_told_from_a_failed_one(
    #[case] stderr: &str,
    #[case] is_nothing: bool,
) {
    assert_eq!(is_nothing_to_stop(stderr), is_nothing);
}

// Kills a removal a crash cut short, while git still knows the tree, finished without checking
// the folder for work added since (`!is_cleanup_started` alone deciding).
#[tokio::test]
async fn a_cut_short_removal_git_still_knows_keeps_new_work_aside() {
    let fixture = CleanupFixture::new(test_git_runner()).await;
    let folder = fixture.add_tree("resumed").await;
    std::fs::write(folder.join("new.txt"), "new work\n").expect("the new work is written");
    let connection = fixture.database.reader();
    let resumed = store_retired_tree(&connection, &fixture.mount, &folder);
    connection
        .execute(
            "UPDATE worktrees SET cleanup_started_at = ?1 WHERE id = ?2",
            params![PARENT_ROWS_AT, resumed.to_string()],
        )
        .expect("the earlier pass's decision is recorded");
    let keeper = RecordingKeeper::default();

    let report = fixture
        .service
        .cleanup_pass(&keeper, &[], &CancellationToken::new())
        .await
        .expect("the pass succeeds");

    assert_eq!(report.kept, [resumed]);
    assert_eq!(*keeper.kept.lock().expect("the keeper's list"), [resumed]);
    assert!(folder.join("new.txt").exists(), "new work is never deleted");
    assert!(
        fixture.repository.join(".git/worktrees/resumed").exists(),
        "git's record stays with the folder"
    );
}

// Kills the stop gated on the repository's `core.fsmonitor` setting, which a daemon started
// earlier or by another tool outlives, and the stop issued without letting a remote volume
// through.
#[tokio::test]
async fn the_cleanup_stops_a_running_file_watch_daemon_whatever_the_repository_sets() {
    let scratch = tempfile::tempdir().expect("a scratch folder for git's trace");
    let trace = scratch.path().join("trace.json");
    let git = test_git_runner_with_environment(&[(
        "GIT_TRACE2_EVENT",
        trace.to_str().expect("the scratch folder's path is text"),
    )]);
    let fixture = CleanupFixture::new(git).await;
    let folder = fixture.add_tree("watched").await;
    git_in(
        &fixture.git,
        &fixture.repository,
        &["config", "core.fsmonitor", "false"],
    )
    .await;
    let environment: Vec<(String, String)> = std::env::vars().collect();
    let _started = StartedFileWatch {
        git: find_git_executable(&environment).expect("the tests run where git is"),
        folder: folder.clone(),
    };
    // A git with no daemon on this platform (Linux before git 2.55) has no stop to prove.
    if let Err(GitError::Exited { stderr, .. }) = fixture
        .git
        .run(
            None,
            GitCall::read(in_folder(&folder, &["fsmonitor--daemon", "start"])),
        )
        .await
        && stderr.contains("not supported on this platform")
    {
        return;
    }
    let status = || {
        fixture.git.run(
            None,
            GitCall::read(in_folder(&folder, &["fsmonitor--daemon", "status"])),
        )
    };
    assert!(status().await.is_ok(), "the daemon runs before the stop");

    stop_file_watch(&fixture.git, None, &folder)
        .await
        .expect("the stop succeeds");

    assert!(status().await.is_err(), "the stop ended the daemon");
    let trace = std::fs::read_to_string(&trace).expect("git's trace reads");
    assert!(
        trace
            .lines()
            .any(|event| event.contains(r#""event":"start""#)
                && event.contains(r#""fsmonitor.allowRemote=true","fsmonitor--daemon","stop"]"#)),
        "the stop lets a remote volume through"
    );
}
