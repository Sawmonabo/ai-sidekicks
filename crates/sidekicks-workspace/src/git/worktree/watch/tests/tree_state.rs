//! The worktree state moves the watch writes, `-> dirty`, back to `ready` and `-> merged`, read
//! through a real worktree whose branch is committed, synced and merged.

use std::path::PathBuf;
use std::time::Duration;

use notify::EventHandler;
use rstest::rstest;
use rusqlite::params;
use sidekicks_contracts::repo::git_reads::WorkingTreeChange;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use tokio::sync::mpsc;

use super::{Fixture, listener, next_change, written};
use crate::folder::canonical_path::canonical_folder_path;
use crate::git::process::test_repository::{commit_empty, git_in};
use crate::git::worktree::watch::{WatchSubscription, no_ceiling};
use crate::test_rows::PARENT_ROWS_AT;

/// The daemon's worktree on `feature`, cut from `main` and watched through its session, with what
/// a test reads and tells there.
struct WatchedTree {
    fixture: Fixture,
    repository: PathBuf,
    tree: PathBuf,
    session_id: SessionId,
    worktree_id: String,
    changes: mpsc::UnboundedReceiver<WorkingTreeChange>,
    _subscription: WatchSubscription,
}

impl WatchedTree {
    async fn new() -> Self {
        let fixture = Fixture::new(no_ceiling, Duration::from_secs(180)).await;
        let repository = fixture.repository("one").await;
        let tree = fixture.scratch.path().join("feature");
        git_in(
            &fixture.git,
            &repository,
            &["worktree", "add", "-b", "feature", &tree.to_string_lossy()],
        )
        .await;
        let session_id = fixture.session(Some(&tree), "feature");
        let worktree_id = mint_uuid_v7().to_string();
        fixture
            .database
            .reader()
            .execute(
                "INSERT INTO worktrees (id, repo_mount_id, created_by_session_id, branch_name, \
                 base_ref, fs_root, state, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, 'feature', 'main', ?4, 'ready', ?5, ?5)",
                params![
                    worktree_id,
                    fixture.mount.to_string(),
                    session_id.text().as_str(),
                    tree.to_string_lossy(),
                    PARENT_ROWS_AT,
                ],
            )
            .expect("the tree's row is stored");
        let (on_change, changes) = listener();
        let subscription = fixture
            .watcher
            .subscribe(&session_id, on_change)
            .await
            .expect("subscribed");
        Self {
            fixture,
            repository,
            tree,
            session_id,
            worktree_id,
            changes,
            _subscription: subscription,
        }
    }

    // The row's state and its `worktree.*` events, read once the folder's task has finished all
    // it was told: a raise is read after them, and its change goes out after them.
    async fn settled_state(&mut self) -> (String, Vec<String>) {
        self.fixture
            .watcher
            .raise_staleness(&self.session_id)
            .await
            .expect("the folder is raised");
        next_change(&mut self.changes).await;
        let connection = self.fixture.database.reader();
        let state = connection
            .query_row("SELECT state FROM worktrees", [], |row| row.get(0))
            .expect("the row reads");
        let events = connection
            .prepare(
                "SELECT type || ' ' || json_extract(payload, '$.worktreeId') || ' ' || \
                 json_extract(payload, '$.state') FROM session_events \
                 WHERE type LIKE 'worktree.%' ORDER BY sequence",
            )
            .expect("the query prepares")
            .query_map([], |row| row.get(0))
            .expect("the events are read")
            .collect::<rusqlite::Result<_>>()
            .expect("each event reads");
        (state, events)
    }

    // Tells the watch that `branch` moved, as a commit, merge or reset there writes its ref.
    async fn tell_ref_moved(&mut self, branch: &str) {
        let common_folder = canonical_folder_path(&self.repository.join(".git"))
            .await
            .expect("the common folder resolves");
        self.fixture
            .feeds(&self.tree)
            .await
            .git_folder
            .expect("the git folders are watched")
            .handle_event(Ok(written([common_folder
                .join("refs")
                .join("heads")
                .join(branch)])));
        next_change(&mut self.changes).await;
    }

    // Writes `name` in the tree and tells the watch.
    async fn write_file(&mut self, name: &str) {
        std::fs::write(self.tree.join(name), name).expect("written");
        self.tell_file_changed(name).await;
    }

    // Removes `name` from the tree and tells the watch.
    async fn remove_file(&mut self, name: &str) {
        std::fs::remove_file(self.tree.join(name)).expect("removed");
        self.tell_file_changed(name).await;
    }

    async fn tell_file_changed(&mut self, name: &str) {
        let root = canonical_folder_path(&self.tree)
            .await
            .expect("the tree resolves");
        self.fixture
            .feeds(&self.tree)
            .await
            .tree
            .expect("the tree is watched")
            .handle_event(Ok(written([root.join(name)])));
        next_change(&mut self.changes).await;
    }

    // Commits `name`, written in the tree, on its branch.
    async fn commit_file(&self, name: &str) {
        git_in(&self.fixture.git, &self.tree, &["add", name]).await;
        commit_empty(&self.fixture.git, &self.tree, name).await;
    }

    fn event(&self, kind: &str, state: &str) -> String {
        format!("worktree.{kind} {} {state}", self.worktree_id)
    }
}

/// How a test merges a tree's branch into its base.
#[derive(Clone, Copy, Debug)]
enum MergeStyle {
    /// The base moves to the branch's tip.
    FastForward,
    /// The branch's changes land on the base as one new commit.
    Squash,
}

// A fresh tree reads neither dirty nor merged; new uncommitted work moves its row `-> dirty`,
// committing it back to `ready`, and its branch merged back `-> merged`, each with its one event;
// a merged tree dirtied and cleaned by file edits alone reads merged again. Kills a move written
// without its event, an event appended without its move, a fresh tree read as merged, the clean
// move dropped, a squash merge left unseen, a fast-forward merge whose commit the watch never saw
// before it merged left unseeded from the reflog, and a clean move that leaves the merged check
// waiting for a change in the git folder.
#[rstest]
#[case::fast_forward(MergeStyle::FastForward)]
#[case::squash(MergeStyle::Squash)]
#[tokio::test]
async fn a_tree_reads_dirty_then_ready_then_merged_once_its_own_commits_merge_back(
    #[case] style: MergeStyle,
) {
    let mut watched = WatchedTree::new().await;
    assert_eq!(
        watched.settled_state().await,
        ("ready".to_owned(), Vec::new()),
        "a fresh tree is neither dirty nor merged"
    );

    watched.write_file("work.txt").await;
    assert_eq!(
        watched.settled_state().await,
        ("dirty".to_owned(), vec![watched.event("dirtied", "dirty")])
    );

    watched.commit_file("work.txt").await;
    let (git, repository) = (&watched.fixture.git, &watched.repository);
    match style {
        MergeStyle::FastForward => {
            git_in(git, repository, &["merge", "--ff-only", "feature"]).await;
        }
        MergeStyle::Squash => {
            git_in(git, repository, &["merge", "--squash", "feature"]).await;
            commit_empty(git, repository, "the feature").await;
        }
    }
    watched.tell_ref_moved("main").await;
    assert_eq!(
        watched.settled_state().await,
        (
            "merged".to_owned(),
            vec![
                watched.event("dirtied", "dirty"),
                watched.event("cleaned", "ready"),
                watched.event("merged", "merged"),
            ]
        )
    );

    watched.write_file("scratch.txt").await;
    watched.remove_file("scratch.txt").await;
    let (state, events) = watched.settled_state().await;
    assert_eq!(state, "merged");
    assert_eq!(
        events[3..],
        [
            watched.event("dirtied", "dirty"),
            watched.event("cleaned", "ready"),
            watched.event("merged", "merged"),
        ]
    );
}

/// How a test leaves a tree's branch level with or behind its base without merging work back.
#[derive(Clone, Copy, Debug)]
enum UnmergedStyle {
    /// The branch catches up with its base by a fast-forward.
    FastForwardSync,
    /// The branch catches up with its base through a merge commit.
    MergeCommitSync,
    /// The branch's own commit is discarded by a reset back to its base.
    ResetToBase,
}

// A branch whose own work never reached its base reads `ready` with no event. Kills, by case: a
// fast-forward sync's moved tip read as merged (a reflog seed that takes any entry, or a contained
// tip read as merged with no recorded one); a merge commit counted as the branch's own work, which
// the patch test then finds applied; and the checks run on the current tip, which the reset left
// contained, in place of the recorded one that holds the discarded work.
#[rstest]
#[case::fast_forward_sync(UnmergedStyle::FastForwardSync)]
#[case::merge_commit_sync(UnmergedStyle::MergeCommitSync)]
#[case::reset_to_base(UnmergedStyle::ResetToBase)]
#[tokio::test]
async fn a_branch_whose_own_work_never_reached_its_base_is_not_merged(
    #[case] style: UnmergedStyle,
) {
    let mut watched = WatchedTree::new().await;
    let (git, repository, tree) = (
        watched.fixture.git.clone(),
        watched.repository.clone(),
        watched.tree.clone(),
    );
    if matches!(style, UnmergedStyle::ResetToBase) {
        std::fs::write(tree.join("work.txt"), "work").expect("written");
        watched.commit_file("work.txt").await;
        watched.tell_ref_moved("feature").await;
    }
    commit_empty(&git, &repository, "elsewhere").await;
    let sync: &[&str] = match style {
        UnmergedStyle::FastForwardSync => &["merge", "--ff-only", "main"],
        UnmergedStyle::MergeCommitSync => &[
            "-c",
            "commit.gpgSign=false",
            "merge",
            "--no-ff",
            "--no-edit",
            "main",
        ],
        UnmergedStyle::ResetToBase => &["reset", "--hard", "main"],
    };
    git_in(&git, &tree, sync).await;
    watched.tell_ref_moved("feature").await;

    assert_eq!(
        watched.settled_state().await,
        ("ready".to_owned(), Vec::new())
    );
}
