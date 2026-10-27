use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use notify::event::{DataChange, Flag, ModifyKind};
use notify::{Event, EventHandler, EventKind, NullWatcher};
use rstest::rstest;
use rusqlite::params;
use sidekicks_contracts::repo::git_reads::{WorkingTreeChange, WorkingTreeChangeMode};
use sidekicks_contracts::repo::mount::{ExecutionMode, RepoMountId, WorkspaceState};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_platforms::WallClockTimer;
use tempfile::TempDir;
use tokio::sync::mpsc;
use tokio::time::timeout;

use super::{
    ReadWatchCeiling, WatchTarget, WorkingFolderWatcher, WorkingFolderWatcherDeps,
    WorkingTreeChangeListener,
};
use crate::file_watch::ChangeFeed;
use crate::folder::canonical_path::canonical_folder_path;
use crate::git::process::{GitCall, GitRunner, in_folder, test_git_runner};
use crate::git::worktree::event_emitter::WorktreeEventEmitter;
use crate::git::worktree::occupancy::MountOccupancyReader;
use crate::git::worktree::schema::schema_parts;
use crate::test_rows::{PARENT_ROWS_AT, project_and_mount_rows};
use sidekicks_std::scheduler::Scheduler;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::events::log_service::test_log::open_log;

const WAIT: Duration = Duration::from_secs(10);

// Long enough for a change that would wrongly be sent to arrive.
const QUIET: Duration = Duration::from_millis(500);

const READ_STATEMENT_CAPACITY: usize = 16;

/// The feeds a folder's watches were started with, through which a test tells changes.
#[derive(Clone, Default)]
pub(super) struct FolderFeeds {
    /// The tree watch's feed.
    pub(super) tree: Option<ChangeFeed>,
    /// The git-folder watch's feed.
    pub(super) git_folder: Option<ChangeFeed>,
}

#[expect(
    clippy::unnecessary_wraps,
    reason = "it stands in for the machine's ceiling read, which can fail"
)]
fn no_ceiling() -> io::Result<Option<u64>> {
    Ok(None)
}

struct Fixture {
    database: TestDatabase,
    scratch: TempDir,
    git: GitRunner,
    mount: RepoMountId,
    watcher: WorkingFolderWatcher<NullWatcher>,
}

impl Fixture {
    async fn new(read_watch_ceiling: ReadWatchCeiling, slow_tick_interval: Duration) -> Self {
        let database = TestDatabase::new(schema_parts());
        let log = open_log(&database, None).await;
        let reads = Arc::new(DatabaseReadPool::new(
            database.path(),
            READ_STATEMENT_CAPACITY,
        ));
        let git = test_git_runner();
        let mount_id = mint_uuid_v7().to_string();
        let connection = database.reader();
        for row in project_and_mount_rows(&mount_id, None) {
            connection
                .execute_batch(&row)
                .expect("the project and its mount are stored");
        }
        let watcher = WorkingFolderWatcher::new(WorkingFolderWatcherDeps {
            git: git.clone(),
            reads: Arc::clone(&reads),
            occupancy: MountOccupancyReader::new(reads),
            events: Arc::new(WorktreeEventEmitter::new(Arc::clone(&log.service))),
            scheduler: Arc::new(Scheduler::start(
                Arc::new(WallClockTimer::new().expect("the wall-clock timer is made")),
                None,
                tokio::sync::watch::channel(0).1,
            )),
            read_watch_ceiling,
            slow_tick_interval,
        });
        Self {
            database,
            scratch: tempfile::tempdir().expect("a scratch folder"),
            git,
            mount: RepoMountId::new(&mount_id).expect("a minted id is a mount id"),
            watcher,
        }
    }

    async fn git_in(&self, folder: &Path, arguments: &[&str]) {
        self.git
            .run(None, GitCall::read(in_folder(folder, arguments)))
            .await
            .expect("git runs in the test repository");
    }

    // A repository on `main` with one commit holding `src/lib.rs` and a `.gitignore` of `build/`.
    async fn repository(&self, name: &str) -> PathBuf {
        let folder = self.scratch.path().join(name);
        std::fs::create_dir_all(folder.join("src")).expect("the folders are made");
        std::fs::write(folder.join("src").join("lib.rs"), "fn main() {}\n").expect("written");
        std::fs::write(folder.join(".gitignore"), "build/\n").expect("written");
        self.git
            .run(
                None,
                GitCall::read([
                    OsString::from("init"),
                    OsString::from("--initial-branch=main"),
                    folder.clone().into_os_string(),
                ]),
            )
            .await
            .expect("the repository is made");
        self.git_in(&folder, &["add", "."]).await;
        self.git_in(
            &folder,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "commit.gpgSign=false",
                "commit",
                "-m",
                "first",
            ],
        )
        .await;
        folder
    }

    // A session on `branch` standing in `folder`, or in none.
    fn session(&self, folder: Option<&Path>, branch: &str) -> SessionId {
        let session_id = test_session_id();
        let connection = self.database.reader();
        insert_session_row(&connection, session_id.text().as_str(), None, None);
        connection
            .execute(
                "UPDATE sessions SET branch = ?1 WHERE id = ?2",
                params![branch, session_id.text().as_str()],
            )
            .expect("the branch is recorded");
        if let Some(folder) = folder {
            self.stand_in(&session_id, folder);
        }
        session_id
    }

    fn stand_in(&self, session_id: &SessionId, folder: &Path) {
        self.database
            .reader()
            .execute(
                "INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, fs_root, \
                 state, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![
                    mint_uuid_v7().to_string(),
                    session_id.text().as_str(),
                    self.mount.to_string(),
                    <&'static str>::from(ExecutionMode::ProvisionedWorktree),
                    folder.to_string_lossy(),
                    <&'static str>::from(WorkspaceState::Ready),
                    PARENT_ROWS_AT,
                ],
            )
            .expect("the workspace is stored");
    }

    fn record_branch(&self, session_id: &SessionId, branch: &str) {
        self.database
            .reader()
            .execute(
                "UPDATE sessions SET branch = ?1 WHERE id = ?2",
                params![branch, session_id.text().as_str()],
            )
            .expect("the branch is recorded");
    }

    fn target(&self, folder: &Path) -> WatchTarget {
        WatchTarget {
            folder: folder.to_path_buf(),
            repo_mount_id: self.mount,
            place: None,
        }
    }

    async fn feeds(&self, folder: &Path) -> FolderFeeds {
        let key = canonical_folder_path(folder)
            .await
            .expect("the folder resolves");
        self.watcher
            .shared
            .lock_state()
            .folders
            .get(&key)
            .map(|entry| entry.feeds.clone())
            .expect("the folder is watched")
    }

    fn watched_folder_count(&self) -> usize {
        self.watcher.shared.lock_state().folders.len()
    }

    fn tree_watch_starts(&self) -> u64 {
        self.watcher.shared.lock_state().tree_watch_starts
    }
}

fn listener() -> (
    WorkingTreeChangeListener,
    mpsc::UnboundedReceiver<WorkingTreeChange>,
) {
    let (sender, changes) = mpsc::unbounded_channel();
    let listener: WorkingTreeChangeListener = Arc::new(move |change| {
        sender.send(change).expect("the test reads every change");
    });
    (listener, changes)
}

async fn next_change(
    changes: &mut mpsc::UnboundedReceiver<WorkingTreeChange>,
) -> WorkingTreeChange {
    timeout(WAIT, changes.recv())
        .await
        .expect("a change arrives in time")
        .expect("the listener is held")
}

async fn assert_quiet(changes: &mut mpsc::UnboundedReceiver<WorkingTreeChange>) {
    assert!(
        timeout(QUIET, changes.recv()).await.is_err(),
        "no change is sent"
    );
}

fn written(paths: impl IntoIterator<Item = PathBuf>) -> Event {
    paths.into_iter().fold(
        Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content))),
        Event::add_path,
    )
}

// Kills a watch per hold, and a release that ignores the count or never ends the watch.
#[tokio::test]
async fn holds_on_one_folder_share_one_watch_until_the_last_release() {
    let fixture = Fixture::new(no_ceiling, Duration::from_secs(180)).await;
    let folder = fixture.repository("one").await;
    let target = fixture.target(&folder);

    let first = fixture
        .watcher
        .hold(&target)
        .await
        .expect("the folder is held");
    let second = fixture
        .watcher
        .hold(&target)
        .await
        .expect("the folder is held");
    assert_eq!(fixture.tree_watch_starts(), 1);
    drop(first);
    assert_eq!(
        fixture.watched_folder_count(),
        1,
        "one hold keeps the watch"
    );
    drop(second);
    assert_eq!(
        fixture.watched_folder_count(),
        0,
        "the last release ends it"
    );

    let _third = fixture
        .watcher
        .hold(&target)
        .await
        .expect("the folder is held");
    assert_eq!(
        fixture.tree_watch_starts(),
        2,
        "a later hold starts a new watch"
    );
}

// Kills the ignored paths left out of the filter, and one change sent per notice.
#[tokio::test]
async fn a_burst_raises_once_and_an_ignored_write_raises_nothing() {
    let fixture = Fixture::new(no_ceiling, Duration::from_secs(180)).await;
    let folder = fixture.repository("one").await;
    std::fs::create_dir_all(folder.join("build")).expect("the build folder is made");
    std::fs::write(folder.join("build").join("out.o"), "object").expect("written");
    let session_id = fixture.session(Some(&folder), "main");
    let (on_change, mut changes) = listener();
    let _subscription = fixture
        .watcher
        .subscribe(&session_id, on_change)
        .await
        .expect("the session is subscribed");
    let root = canonical_folder_path(&folder)
        .await
        .expect("the folder resolves");
    let mut tree = fixture
        .feeds(&folder)
        .await
        .tree
        .expect("the tree is watched");

    tree.handle_event(Ok(written([root.join("build").join("out.o")])));
    assert_quiet(&mut changes).await;

    // More paths than one notice carries, so the burst reaches the folder as two notices.
    for index in 0..300 {
        tree.handle_event(Ok(written([root.join("src").join(format!("f{index}.rs"))])));
    }
    let change = next_change(&mut changes).await;
    assert_eq!(change.session_id, session_id);
    assert_eq!(change.mode, WorkingTreeChangeMode::Watch);
    assert_quiet(&mut changes).await;
}

// Kills a raise sent to every folder, and a session with no folder refused or never followed.
#[tokio::test]
async fn a_raise_reaches_its_folder_alone_and_a_session_without_one_is_followed_in() {
    let fixture = Fixture::new(no_ceiling, Duration::from_secs(180)).await;
    let one = fixture.repository("one").await;
    let two = fixture.repository("two").await;
    let in_one = fixture.session(Some(&one), "main");
    let in_two = fixture.session(Some(&two), "main");
    let without = fixture.session(None, "main");
    let (one_listener, mut one_changes) = listener();
    let (two_listener, mut two_changes) = listener();
    let (without_listener, mut without_changes) = listener();
    let _one = fixture
        .watcher
        .subscribe(&in_one, one_listener)
        .await
        .expect("subscribed");
    let _two = fixture
        .watcher
        .subscribe(&in_two, two_listener)
        .await
        .expect("subscribed");
    let _without = fixture
        .watcher
        .subscribe(&without, without_listener)
        .await
        .expect("a session with no folder is subscribed");

    fixture
        .watcher
        .raise_staleness(&in_one)
        .await
        .expect("raised");
    assert_eq!(next_change(&mut one_changes).await.session_id, in_one);
    assert_quiet(&mut two_changes).await;
    assert_quiet(&mut without_changes).await;

    fixture.stand_in(&without, &one);
    fixture.watcher.follow(&without).await.expect("followed");
    fixture
        .watcher
        .raise_staleness(&in_one)
        .await
        .expect("raised");
    assert_eq!(next_change(&mut one_changes).await.session_id, in_one);
    assert_eq!(next_change(&mut without_changes).await.session_id, without);
    assert_quiet(&mut two_changes).await;
}

#[expect(
    clippy::unnecessary_wraps,
    reason = "it stands in for the machine's ceiling read, which can fail"
)]
fn ceiling_of_six() -> io::Result<Option<u64>> {
    Ok(Some(6))
}

#[expect(
    clippy::unnecessary_wraps,
    reason = "it stands in for the machine's ceiling read, which can fail"
)]
fn ceiling_of_five() -> io::Result<Option<u64>> {
    Ok(Some(5))
}

// The tree keeps two folders, its root and `src`, and its git folder four more, itself, `refs`,
// `refs/heads` and `refs/tags`: six. Kills the count ignored or compared with `>=`, the ref folders
// left out of it, a first tick that raises, and a reading that leaves the modified time out.
#[rstest]
#[case::fits(ceiling_of_six, WorkingTreeChangeMode::Watch)]
#[case::over(ceiling_of_five, WorkingTreeChangeMode::SlowTick)]
#[tokio::test]
async fn a_folder_past_the_watch_limit_is_checked_on_the_slow_tick(
    #[case] ceiling: ReadWatchCeiling,
    #[case] expected: WorkingTreeChangeMode,
) {
    let fixture = Fixture::new(ceiling, Duration::from_millis(100)).await;
    let folder = fixture.repository("one").await;
    let untracked = folder.join("src").join("new.rs");
    std::fs::write(&untracked, "aaaa").expect("written");
    let session_id = fixture.session(Some(&folder), "main");
    let (on_change, mut changes) = listener();
    let _subscription = fixture
        .watcher
        .subscribe(&session_id, on_change)
        .await
        .expect("subscribed");

    fixture
        .watcher
        .raise_staleness(&session_id)
        .await
        .expect("raised");
    assert_eq!(next_change(&mut changes).await.mode, expected);
    if expected == WorkingTreeChangeMode::Watch {
        return;
    }

    // Several ticks pass over an unchanged folder, the first of them setting the baseline.
    assert_quiet(&mut changes).await;
    // The same length, so only the modified time moves.
    std::fs::write(&untracked, "bbbb").expect("written");
    assert_eq!(
        next_change(&mut changes).await.mode,
        WorkingTreeChangeMode::SlowTick
    );
}

// Kills a write-back to every standing session, and a previous branch taken from the folder in
// place of the session's record.
#[tokio::test]
async fn a_moved_head_writes_the_branch_back_to_each_session_not_on_it() {
    let fixture = Fixture::new(no_ceiling, Duration::from_secs(180)).await;
    let folder = fixture.repository("one").await;
    let behind = fixture.session(Some(&folder), "main");
    let already_on_it = fixture.session(Some(&folder), "main");
    let (on_change, mut changes) = listener();
    let _subscription = fixture
        .watcher
        .subscribe(&behind, on_change)
        .await
        .expect("subscribed");
    fixture.record_branch(&behind, "old");
    fixture.record_branch(&already_on_it, "feature");

    fixture
        .git_in(&folder, &["switch", "--create", "feature"])
        .await;
    let git_folder = canonical_folder_path(&folder.join(".git"))
        .await
        .expect("the git folder resolves");
    fixture
        .feeds(&folder)
        .await
        .git_folder
        .expect("the git folder is watched")
        .handle_event(Ok(written([git_folder.join("HEAD")])));
    next_change(&mut changes).await;

    let written_back: Vec<(String, String, String)> = fixture
        .database
        .reader()
        .prepare(
            "SELECT json_extract(payload, '$.sessionId'), json_extract(payload, '$.branch'), \
             json_extract(payload, '$.previousBranch') FROM session_events \
             WHERE type = 'session.branch.changed'",
        )
        .expect("the query prepares")
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .expect("the events are read")
        .collect::<rusqlite::Result<_>>()
        .expect("each event reads");
    assert_eq!(
        written_back,
        vec![(
            behind.text().as_str().to_owned(),
            "feature".to_owned(),
            "old".to_owned()
        )]
    );
}

// Kills the common folder's refs left unwatched or filtered out, which leaves a linked tree's
// changes pane stale after a branch tip moves without its HEAD or index, and the common folder
// keeping the main checkout's HEAD and index, which marks every linked tree stale at each of its
// adds and status reads.
#[tokio::test]
async fn a_linked_tree_is_marked_stale_by_a_shared_ref_not_by_the_main_checkout_s_head_or_index() {
    let fixture = Fixture::new(no_ceiling, Duration::from_secs(180)).await;
    let repository = fixture.repository("one").await;
    let tree = fixture.scratch.path().join("linked");
    fixture
        .git_in(
            &repository,
            &["worktree", "add", "-b", "linked", &tree.to_string_lossy()],
        )
        .await;
    let session_id = fixture.session(Some(&tree), "linked");
    let (on_change, mut changes) = listener();
    let _subscription = fixture
        .watcher
        .subscribe(&session_id, on_change)
        .await
        .expect("subscribed");
    let common_folder = canonical_folder_path(&repository.join(".git"))
        .await
        .expect("the common folder resolves");
    let mut git_folders = fixture
        .feeds(&tree)
        .await
        .git_folder
        .expect("the git folders are watched");

    std::fs::write(repository.join("added.txt"), "added").expect("written");
    fixture.git_in(&repository, &["add", "added.txt"]).await;
    let added_object = fixture
        .git
        .run(
            None,
            GitCall::read(in_folder(&repository, &["hash-object", "added.txt"])),
        )
        .await
        .expect("git hashes the added file");
    let added_object = String::from_utf8_lossy(&added_object.stdout)
        .trim()
        .to_owned();
    let (object_folder, object_file) = added_object.split_at(2);
    git_folders.handle_event(Ok(written([
        common_folder.join("index"),
        common_folder
            .join("objects")
            .join(object_folder)
            .join(object_file),
        common_folder.join("HEAD"),
    ])));
    assert!(
        timeout(Duration::from_secs(1), changes.recv())
            .await
            .is_err(),
        "the main checkout's HEAD, index and objects raise no change for the linked tree"
    );

    fixture
        .git_in(&tree, &["update-ref", "refs/heads/linked", "HEAD"])
        .await;
    git_folders.handle_event(Ok(written([common_folder
        .join("refs")
        .join("heads")
        .join("linked")])));

    assert_eq!(next_change(&mut changes).await.session_id, session_id);
}

// Kills a rescan of the common folder that walks only the common root, whose filter refuses
// `worktrees/`, and a pending common walk that swallows the nested root's: the linked tree's own
// HEAD, moved before the rescan, is reported through its own root's walk.
#[tokio::test]
async fn a_rescan_of_the_common_folder_walks_the_linked_tree_s_own_git_folder() {
    let fixture = Fixture::new(no_ceiling, Duration::from_secs(180)).await;
    let repository = fixture.repository("one").await;
    let tree = fixture.scratch.path().join("linked");
    fixture
        .git_in(
            &repository,
            &["worktree", "add", "-b", "linked", &tree.to_string_lossy()],
        )
        .await;
    let session_id = fixture.session(Some(&tree), "linked");
    let (on_change, mut changes) = listener();
    let _subscription = fixture
        .watcher
        .subscribe(&session_id, on_change)
        .await
        .expect("subscribed");
    let common_folder = canonical_folder_path(&repository.join(".git"))
        .await
        .expect("the common folder resolves");
    let mut git_folders = fixture
        .feeds(&tree)
        .await
        .git_folder
        .expect("the git folders are watched");

    fixture
        .git_in(&tree, &["checkout", "--quiet", "-b", "moved"])
        .await;
    git_folders.handle_event(Ok(Event::new(EventKind::Other)
        .set_flag(Flag::Rescan)
        .add_path(common_folder)));

    assert_eq!(next_change(&mut changes).await.session_id, session_id);
}

// Kills the ignored set read with `--directory`, which lists a folder whose files are all ignored
// whole and so hides a file added to it later.
#[tokio::test]
async fn a_file_added_to_a_folder_of_ignored_files_is_seen() {
    let fixture = Fixture::new(no_ceiling, Duration::from_secs(180)).await;
    let folder = fixture.repository("one").await;
    std::fs::write(folder.join(".gitignore"), "build/\n*.log\n").expect("written");
    std::fs::create_dir_all(folder.join("logs")).expect("the logs folder is made");
    std::fs::write(folder.join("logs").join("a.log"), "log").expect("written");
    let session_id = fixture.session(Some(&folder), "main");
    let (on_change, mut changes) = listener();
    let _subscription = fixture
        .watcher
        .subscribe(&session_id, on_change)
        .await
        .expect("subscribed");
    let root = canonical_folder_path(&folder)
        .await
        .expect("the folder resolves");
    let mut tree = fixture
        .feeds(&folder)
        .await
        .tree
        .expect("the tree is watched");

    tree.handle_event(Ok(written([root.join("logs").join("a.log")])));
    assert_quiet(&mut changes).await;

    std::fs::write(folder.join("logs").join("README.md"), "notes").expect("written");
    tree.handle_event(Ok(written([root.join("logs").join("README.md")])));
    assert_eq!(next_change(&mut changes).await.session_id, session_id);
}
