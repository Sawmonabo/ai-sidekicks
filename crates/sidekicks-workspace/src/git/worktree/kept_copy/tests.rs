//! The keep's saved state: the commit a tree on a branch is kept at when its branch moves while the
//! keep runs.

use std::path::{Path, PathBuf};
use std::time::Duration;

use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::worktree::copy_progress::WorktreeCopy;

use super::{
    KeptCopyRowWrites, KeptCopyTools, KeptWorktreeState, RowWriteError, WorktreeAside,
    keep_saved_state,
};
use crate::git::process::test_git_runner_with_environment;
use crate::git::worktree::reads::tree_name_of;
use crate::git::worktree::removal::new_removed_worktree_id;
use crate::git::worktree::removed_store::kept_folder_for;
use crate::git::worktree::removed_store::test_fixture::KeptCopyFixture;

// The argument of the `cat-file` call that reads the tree's HEAD before anything is copied.
const HEAD_READ_ARGUMENT: &str = "--batch-check=%(objectname) %(objecttype)";

// How long the row writes wait for the head read to show in git's trace.
const TRACE_WAIT: Duration = Duration::from_secs(60);

// Row writes that hold the pending row back until the head read has ended in git's trace, then
// commit on the tree's branch, as the person's own git would while the keep runs.
struct CommitAfterHeadRead<'a> {
    fixture: &'a KeptCopyFixture,
    tree_folder: &'a Path,
    trace: &'a Path,
}

impl KeptCopyRowWrites for CommitAfterHeadRead<'_> {
    async fn record_pending(&self) -> Result<(), RowWriteError> {
        tokio::time::timeout(
            TRACE_WAIT,
            wait_for_ended_call(self.trace, HEAD_READ_ARGUMENT),
        )
        .await
        .expect("the head read ends");
        self.fixture
            .commit(self.tree_folder, "landed while the tree was kept")
            .await;
        Ok(())
    }

    async fn record_state(&self, _state: &KeptWorktreeState) -> Result<(), RowWriteError> {
        Ok(())
    }

    async fn forget_pending(&self) -> Result<(), RowWriteError> {
        Ok(())
    }
}

// Waits until git's event trace at `trace` shows the end of a call with `argument` among its
// arguments.
async fn wait_for_ended_call(trace: &Path, argument: &str) {
    loop {
        let events: Vec<serde_json::Value> = std::fs::read_to_string(trace)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        let started = events.iter().find_map(|event| {
            let is_call = event["event"] == "start"
                && event["argv"]
                    .as_array()
                    .is_some_and(|arguments| arguments.iter().any(|named| named == argument));
            is_call.then(|| event["sid"].clone())
        });
        if let Some(sid) = started
            && events
                .iter()
                .any(|event| event["event"] == "exit" && event["sid"] == sid)
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

// A commit lands on the tree's branch after HEAD was read and before the record is copied. Kills
// the kept commit taken from that first read, which pins and records a commit the kept index was
// not made on.
#[tokio::test]
async fn a_tree_on_a_branch_is_kept_at_the_commit_its_branch_names_as_the_record_is_copied() {
    let fixture = KeptCopyFixture::new().await;
    let tree = fixture.add_tree("fix", "fix").await;
    let tree_folder = PathBuf::from(tree.fs_root.as_str());
    let scratch = tempfile::tempdir().expect("a scratch folder for git's trace");
    let trace = scratch.path().join("trace.json");
    let git = test_git_runner_with_environment(&[(
        "GIT_TRACE2_EVENT",
        trace.to_str().expect("the scratch folder's path is text"),
    )]);
    let removed_worktree_id = new_removed_worktree_id();
    let kept_folder = kept_folder_for(&tree, &removed_worktree_id);
    let copy = WorktreeCopy::Removing {
        worktree_id: tree.id,
        project_id: ProjectId::new(&fixture.mount).expect("the project's id"),
        name: tree_name_of(&tree_folder).expect("a tree's name"),
        copied_bytes: SafeInt::ZERO,
        total_bytes: SafeInt::ZERO,
    };

    let kept = keep_saved_state(
        KeptCopyTools {
            git: &git,
            place: None,
            folder_moves: fixture.store.folder_move_tools(),
        },
        WorktreeAside {
            tree_folder: &tree_folder,
            kept_folder: &kept_folder,
            removed_worktree_id: &removed_worktree_id,
            copy: &copy,
        },
        &CommitAfterHeadRead {
            fixture: &fixture,
            tree_folder: &tree_folder,
            trace: &trace,
        },
        &mut false,
        &mut None,
    )
    .await
    .expect("the saved state is kept");

    assert_eq!(
        kept.state.head_commit.as_str(),
        fixture.git(&tree_folder, &["rev-parse", "HEAD"]).await
    );
}
