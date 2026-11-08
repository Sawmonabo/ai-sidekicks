//! The worktree state moves the watch writes, `-> dirty`, back to `ready`, `-> merged` and back
//! from it, read through a real worktree whose branch is committed, synced and merged.

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
use crate::git::process::test_git_runner_with_environment;
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

    // Writes `name` in the tree, untold, and commits it on its branch.
    async fn write_and_commit_file(&self, name: &str) {
        std::fs::write(self.tree.join(name), name).expect("written");
        self.commit_file(name).await;
    }

    // The commit that holds the branch's own work, as the row records it.
    fn recorded_commit(&self) -> Option<String> {
        self.fixture
            .database
            .reader()
            .query_row("SELECT own_work_commit FROM worktrees", [], |row| {
                row.get(0)
            })
            .expect("the row reads")
    }

    // Joins two lines of the branch's own work: `first.txt` committed on the branch with a past
    // committer date, so the side line's `side.txt` on the repository's branch `side` is the
    // newer, then `side` merged into the branch and the watch told. Answers the first commit.
    async fn join_two_own_lines(&mut self) -> String {
        let (git, repository, tree) = (
            self.fixture.git.clone(),
            self.repository.clone(),
            self.tree.clone(),
        );
        git_in(&git, &repository, &["switch", "--quiet", "-c", "side"]).await;
        std::fs::write(repository.join("side.txt"), "side").expect("written");
        git_in(&git, &repository, &["add", "side.txt"]).await;
        commit_empty(&git, &repository, "side").await;
        git_in(&git, &repository, &["switch", "--quiet", "main"]).await;
        let earlier = test_git_runner_with_environment(&[(
            "GIT_COMMITTER_DATE",
            "2001-01-01 00:00:00 +0000",
        )]);
        std::fs::write(tree.join("first.txt"), "first").expect("written");
        git_in(&git, &tree, &["add", "first.txt"]).await;
        commit_empty(&earlier, &tree, "first.txt").await;
        let first = git_in(&git, &tree, &["rev-parse", "HEAD"]).await;
        git_in(&git, &tree, &MERGE_SIDE).await;
        self.tell_ref_moved("feature").await;
        first
    }

    fn event(&self, kind: &str, state: &str) -> String {
        format!("worktree.{kind} {} {state}", self.worktree_id)
    }
}

// Merges the branch `side` with a merge commit of its own.
const MERGE_SIDE: [&str; 6] = [
    "-c",
    "commit.gpgSign=false",
    "merge",
    "--no-ff",
    "--no-edit",
    "side",
];

/// How a test merges a tree's branch into its base.
#[derive(Clone, Copy, Debug)]
enum MergeStyle {
    /// The base moves to the branch's tip.
    FastForward,
    /// The branch's two commits land on the base as one new commit.
    Squash,
}

// A fresh tree reads neither dirty nor merged; new uncommitted work moves its row `-> dirty`,
// committing it back to `ready`, and its branch merged back `-> merged`, each with its one event; a
// merged tree dirtied and cleaned by file edits alone reads merged again, stays merged while only
// its base moves, and moves back to `ready` with its event once it commits work of its own,
// recording that commit. Before the merge the branch's last commit is amended, and a commit made
// after it is reset away, all unseen by the watch. Kills a move written without its event, an event
// appended without its move, a fresh tree read as merged, the clean move dropped, a squash of two
// commits compared only commit by commit, a fast-forward merge whose commit the watch never saw
// before it merged left unseeded from the reflog, an amend left out of the reflog's seed (which
// seeds the work commit before it, so the recorded commit is not the amended one), a seed taken
// from the reflog's newest commit whether or not the base holds it (which seeds the reset commit
// and reads the fast-forward as not merged), a clean move that leaves the merged check waiting for
// a change in the git folder, a merged tree left unchecked, a reopen count not bounded by the
// recorded commit (which reads a squash-merged branch as reopened at the base's next commit), and a
// reopen that does not record its commit.
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
    watched.write_and_commit_file("more.txt").await;
    let (git, repository, tree) = (&watched.fixture.git, &watched.repository, &watched.tree);
    std::fs::write(tree.join("more.txt"), "amended").expect("written");
    git_in(git, tree, &["add", "more.txt"]).await;
    git_in(
        git,
        tree,
        &[
            "-c",
            "commit.gpgSign=false",
            "commit",
            "--quiet",
            "--amend",
            "--no-edit",
        ],
    )
    .await;
    let amended = git_in(git, tree, &["rev-parse", "HEAD"]).await;
    watched.write_and_commit_file("dropped.txt").await;
    git_in(git, tree, &["reset", "--hard", &amended]).await;
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
    assert_eq!(watched.recorded_commit(), Some(amended));

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

    let (git, repository) = (watched.fixture.git.clone(), watched.repository.clone());
    commit_empty(&git, &repository, "elsewhere").await;
    watched.tell_ref_moved("main").await;
    let (state, events) = watched.settled_state().await;
    assert_eq!((state.as_str(), events.len()), ("merged", 6));

    watched.write_and_commit_file("next.txt").await;
    watched.tell_ref_moved("feature").await;
    let (state, events) = watched.settled_state().await;
    assert_eq!(state, "ready");
    assert_eq!(events[6..], [watched.event("reopened", "ready")]);
    let tip = git_in(&git, &watched.tree, &["rev-parse", "HEAD"]).await;
    assert_eq!(watched.recorded_commit(), Some(tip));
}

/// How a test moves a tree's branch and its base.
#[derive(Clone, Copy, Debug)]
enum BranchHistory {
    /// The branch catches up with its base by a fast-forward.
    FastForwardSync,
    /// The branch catches up with its base through a merge commit that also adds a file.
    MergeCommitSync,
    /// The branch's own commit is discarded by a reset back to its base.
    ResetToBase,
    /// The branch's one commit is empty, and its base takes it by a fast-forward.
    EmptyCommit,
    /// The branch's commit after work its base took by a fast-forward is empty.
    EmptyCommitPastMergedWork,
    /// The branch changes a file, syncs with its base through a merge that keeps the base's
    /// version of that file, then makes two commits its base cherry-picks.
    SyncTakingBaseSideThenPicked,
    /// The branch's own work comes in two lines joined by a merge, the side line's commit the
    /// newer; the branch is reset to its base, and its base merges the side line alone.
    TwoLinesOneMerged,
    /// The branch's own work comes in two lines joined by a merge, and its base merges each line
    /// on its own, never the branch's merge.
    TwoLinesMergedApart,
}

// A branch whose own work never reached its base reads `ready` with no event, and one whose work
// did reads `merged` though an empty commit follows it or its lines landed apart. Kills, by case: a
// fast-forward sync's moved tip read as merged (a reflog seed that takes any entry, or a contained
// tip read as merged with no recorded one); a merge commit counted as the branch's own work, which
// records the merge as its commit; the checks run on the current tip, which the reset left
// contained, in place of the recorded one that holds the discarded work; an empty commit counted as
// work of its own, or taken as the reflog's seed, which reads the base's fast-forward to it as
// merged; a branch whose commits past its base change no path read as applied there; the branch's
// tip recorded in place of its newest commit that changes a path, which leaves merged work behind
// an empty commit unread; the per-commit test reading the commits whose changes a sync merge that
// took the base's side on every path the branch changes replaced (as `--full-history` on the patch
// log does), which finds the replaced commit's patch nowhere and reads the picked branch as not
// merged; the newest of two lines recorded though it lacks the other, which reads the base's merge
// of that one line as merged; and a recorded merge of two lines read as merged only when the base
// holds the merge itself, which leaves both lines merged apart unread.
#[rstest]
#[case::fast_forward_sync(BranchHistory::FastForwardSync)]
#[case::merge_commit_sync(BranchHistory::MergeCommitSync)]
#[case::reset_to_base(BranchHistory::ResetToBase)]
#[case::empty_commit(BranchHistory::EmptyCommit)]
#[case::empty_commit_past_merged_work(BranchHistory::EmptyCommitPastMergedWork)]
#[case::sync_taking_base_side_then_picked(BranchHistory::SyncTakingBaseSideThenPicked)]
#[case::two_lines_one_merged(BranchHistory::TwoLinesOneMerged)]
#[case::two_lines_merged_apart(BranchHistory::TwoLinesMergedApart)]
#[tokio::test]
async fn a_branch_reads_merged_only_once_its_own_work_reached_its_base(
    #[case] style: BranchHistory,
) {
    let mut watched = WatchedTree::new().await;
    let (git, repository, tree) = (
        watched.fixture.git.clone(),
        watched.repository.clone(),
        watched.tree.clone(),
    );
    match style {
        BranchHistory::FastForwardSync => {
            commit_empty(&git, &repository, "elsewhere").await;
            git_in(&git, &tree, &["merge", "--ff-only", "main"]).await;
        }
        BranchHistory::MergeCommitSync => {
            commit_empty(&git, &repository, "elsewhere").await;
            git_in(&git, &tree, &["merge", "--no-ff", "--no-commit", "main"]).await;
            std::fs::write(tree.join("resolved.txt"), "resolved").expect("written");
            watched.commit_file("resolved.txt").await;
        }
        BranchHistory::ResetToBase => {
            watched.write_and_commit_file("work.txt").await;
            watched.tell_ref_moved("feature").await;
            commit_empty(&git, &repository, "elsewhere").await;
            git_in(&git, &tree, &["reset", "--hard", "main"]).await;
        }
        BranchHistory::EmptyCommit => {
            commit_empty(&git, &tree, "start").await;
            watched.tell_ref_moved("feature").await;
            git_in(&git, &repository, &["merge", "--ff-only", "feature"]).await;
        }
        BranchHistory::EmptyCommitPastMergedWork => {
            watched.write_and_commit_file("work.txt").await;
            watched.tell_ref_moved("feature").await;
            let work = git_in(&git, &tree, &["rev-parse", "HEAD"]).await;
            commit_empty(&git, &tree, "after").await;
            watched.tell_ref_moved("feature").await;
            git_in(&git, &repository, &["merge", "--ff-only", &work]).await;
        }
        BranchHistory::SyncTakingBaseSideThenPicked => {
            watched.write_and_commit_file("shared.txt").await;
            std::fs::write(repository.join("shared.txt"), "the base's").expect("written");
            git_in(&git, &repository, &["add", "shared.txt"]).await;
            commit_empty(&git, &repository, "the base's shared.txt").await;
            git_in(
                &git,
                &tree,
                &[
                    "-c",
                    "commit.gpgSign=false",
                    "merge",
                    "--no-edit",
                    "-X",
                    "theirs",
                    "main",
                ],
            )
            .await;
            watched.write_and_commit_file("second.txt").await;
            watched.write_and_commit_file("third.txt").await;
            git_in(
                &git,
                &repository,
                &[
                    "-c",
                    "commit.gpgSign=false",
                    "cherry-pick",
                    "feature~1",
                    "feature",
                ],
            )
            .await;
        }
        BranchHistory::TwoLinesOneMerged => {
            watched.join_two_own_lines().await;
            git_in(&git, &tree, &["reset", "--hard", "main"]).await;
            git_in(&git, &repository, &MERGE_SIDE).await;
        }
        BranchHistory::TwoLinesMergedApart => {
            let first = watched.join_two_own_lines().await;
            let merge_first = [
                "-c",
                "commit.gpgSign=false",
                "merge",
                "--no-ff",
                "--no-edit",
                &first,
            ];
            git_in(&git, &repository, &merge_first).await;
            git_in(&git, &repository, &MERGE_SIDE).await;
        }
    }
    watched.tell_ref_moved("feature").await;
    watched.tell_ref_moved("main").await;

    let expected = if matches!(
        style,
        BranchHistory::EmptyCommitPastMergedWork
            | BranchHistory::SyncTakingBaseSideThenPicked
            | BranchHistory::TwoLinesMergedApart
    ) {
        ("merged".to_owned(), vec![watched.event("merged", "merged")])
    } else {
        ("ready".to_owned(), Vec::new())
    };
    assert_eq!(watched.settled_state().await, expected);
    let is_commit_recorded = watched.recorded_commit().is_some();
    assert_eq!(
        is_commit_recorded,
        matches!(
            style,
            BranchHistory::ResetToBase
                | BranchHistory::EmptyCommitPastMergedWork
                | BranchHistory::SyncTakingBaseSideThenPicked
                | BranchHistory::TwoLinesOneMerged
                | BranchHistory::TwoLinesMergedApart
        ),
        "only a branch that held work of its own records a commit"
    );
}
