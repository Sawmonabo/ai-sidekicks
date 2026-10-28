//! The store's tests: a refused put-back keeps the copy, `Delete now` deletes it while no cleanup
//! pass does, and a put-back a crash cut short is undone.

use std::error::Error;
use std::fs;
use std::path::Path;
use std::sync::Mutex;

use futures::future::BoxFuture;
use rstest::rstest;
use rusqlite::params;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::repo::mount::RepoMountState;
use sidekicks_contracts::worktree::lifecycle::{RemovedWorktreeId, WorktreeId};
use sidekicks_contracts::worktree::removed::{
    WorktreeRemovedListRequest, WorktreeRestoreRefusal, WorktreeRestoreResponse,
};
use tokio_util::sync::CancellationToken;

use super::put_back_copy;
use super::restore::KeptCopyPutBackMarks;
use super::test_fixture::KeptCopyFixture;
use crate::git::worktree::kept_copy::KEPT_TREE_ENTRY;
use crate::git::worktree::put_back::{
    PutBackAtFreeNameInput, PutBackBranchChoice, put_worktree_back_at_free_name,
};
use crate::git::worktree::rows::WorktreeRow;
use crate::git::worktree::service::cleanup::RetiredWorktreeKeeper;

// A keeper that records each tree a cleanup pass asks it to keep aside.
#[derive(Default)]
struct RecordingKeeper {
    kept: Mutex<Vec<WorktreeId>>,
}

impl RetiredWorktreeKeeper for RecordingKeeper {
    fn keep_retired_aside<'a>(
        &'a self,
        row: &'a WorktreeRow,
    ) -> BoxFuture<'a, Result<(), Box<dyn Error + Send + Sync>>> {
        Box::pin(async move {
            self.kept.lock().expect("the keeper's list").push(row.id);
            Ok(())
        })
    }
}

// The kept copies the list shows.
async fn listed_ids(fixture: &KeptCopyFixture) -> Vec<RemovedWorktreeId> {
    fixture
        .store
        .list(&WorktreeRemovedListRequest { project_id: None })
        .await
        .expect("the kept worktrees are listed")
        .removed_worktrees
        .into_iter()
        .map(|listed| listed.removed_worktree_id)
        .collect()
}

#[derive(Clone, Copy, Debug)]
enum RefusalCase {
    ProjectNotAttached,
    RepositoryMissing,
    KeptTreeMissing,
}

// Kills a refusal that deletes the row or the kept folder, and a put-back that runs past one.
#[rstest]
#[case::project_not_attached(RefusalCase::ProjectNotAttached)]
#[case::repository_missing(RefusalCase::RepositoryMissing)]
#[case::kept_tree_missing(RefusalCase::KeptTreeMissing)]
#[tokio::test]
async fn a_refused_put_back_keeps_the_row_and_the_kept_folder(#[case] case: RefusalCase) {
    let fixture = KeptCopyFixture::new().await;
    let tree = fixture.add_tree("fix", "fix").await;
    let removed_worktree_id = fixture.discard(&tree).await;
    let kept_folder = fixture.kept_folder(&removed_worktree_id);
    let refusal = match case {
        RefusalCase::ProjectNotAttached => {
            fixture
                .database
                .reader()
                .execute(
                    "UPDATE repo_mounts SET state = ?1 WHERE id = ?2",
                    params![
                        <&'static str>::from(RepoMountState::Detached),
                        fixture.mount
                    ],
                )
                .expect("the mount is detached");
            WorktreeRestoreRefusal::ProjectNotAttached {}
        }
        RefusalCase::RepositoryMissing => {
            fs::rename(
                &fixture.repository,
                fixture.repository.with_file_name("moved"),
            )
            .expect("the repository is moved away");
            WorktreeRestoreRefusal::RepositoryMissing {
                path: FilesystemPath::new(fixture.repository.to_string_lossy().into_owned())
                    .expect("the repository's folder"),
            }
        }
        RefusalCase::KeptTreeMissing => {
            fs::remove_dir_all(kept_folder.join(KEPT_TREE_ENTRY))
                .expect("the kept tree is removed");
            WorktreeRestoreRefusal::KeptTreeMissing {}
        }
    };

    let response = fixture
        .store
        .restore(removed_worktree_id)
        .await
        .expect("the put-back answers");

    assert_eq!(response, WorktreeRestoreResponse::Refused { refusal });
    assert_eq!(listed_ids(&fixture).await, vec![removed_worktree_id]);
    assert!(kept_folder.is_dir());
}

// Kills a cleanup pass that removes a listed kept copy, and a `Delete now` that leaves its
// folder, a pin or its row.
#[tokio::test]
async fn delete_now_removes_the_kept_copy_no_cleanup_pass_touches() {
    let fixture = KeptCopyFixture::new().await;
    let tree = fixture.add_tree("fix", "fix").await;
    fixture.commit(&fixture.tree_at("fix"), "work").await;
    let removed_worktree_id = fixture.discard(&tree).await;
    let kept_folder = fixture.kept_folder(&removed_worktree_id);
    let pin_prefix = format!("refs/sidekicks/removed/{removed_worktree_id}/");
    let pin_arguments = ["for-each-ref", "--format=%(refname)", pin_prefix.as_str()];
    let read_pins = || fixture.git(&fixture.repository, &pin_arguments);
    let keeper = RecordingKeeper::default();
    fixture
        .worktrees
        .cleanup_pass(&keeper, &[], &CancellationToken::new())
        .await
        .expect("the cleanup pass runs");
    assert!(kept_folder.is_dir());
    assert!(!read_pins().await.is_empty());
    assert!(keeper.kept.lock().expect("the keeper's list").is_empty());

    fixture
        .store
        .delete(removed_worktree_id)
        .await
        .expect("Delete now runs");

    assert!(!kept_folder.exists());
    assert_eq!(read_pins().await, "");
    assert_eq!(listed_ids(&fixture).await, Vec::new());
}

// Kills a put-back a crash cut short left in place: its tree unrecorded where it went, its
// record in the repository and its kept copy short of the tree.
#[tokio::test]
async fn an_interrupted_put_back_is_undone_at_the_next_pass() {
    let fixture = KeptCopyFixture::new().await;
    let tree = fixture.add_tree("fix", "fix").await;
    let removed_worktree_id = fixture.discard(&tree).await;
    let kept = fixture
        .store
        .find_row(removed_worktree_id)
        .await
        .expect("the kept copy's row is read")
        .expect("the kept copy is listed");
    let kept_folder = Path::new(kept.kept_path.as_str());
    let common_folder = fixture.common_folder();
    let placed = put_worktree_back_at_free_name(
        fixture.store.put_back_tools(None),
        PutBackAtFreeNameInput {
            kept_folder,
            original_path: Path::new(kept.original_path.as_str()),
            branch: kept.branch.as_str(),
            canonical_root: &fixture.repository,
            common_folder: &common_folder,
            choice: &PutBackBranchChoice::OwnBranch,
            copy: &put_back_copy(&kept),
        },
        &KeptCopyPutBackMarks {
            store: &fixture.store,
            kept: &kept,
        },
    )
    .await
    .expect("the tree is put back");
    // As a crash leaves it: the tree in its folder and the row marked, nothing recording it.
    let target_folder = placed.target_folder.clone();
    drop(placed);
    assert!(target_folder.join(".git").is_file());
    assert_eq!(
        fixture
            .store
            .list_interrupted_put_backs()
            .await
            .expect("the interrupted put-backs are read"),
        vec![removed_worktree_id]
    );

    assert!(
        fixture
            .store
            .finish_interrupted_put_back(removed_worktree_id)
            .await
            .expect("the interrupted put-back is undone")
    );

    assert!(!target_folder.exists());
    assert!(kept_folder.join(KEPT_TREE_ENTRY).is_dir());
    assert!(!common_folder.join("worktrees").join("fix").exists());
    assert_eq!(
        fixture
            .store
            .list_interrupted_put_backs()
            .await
            .expect("the interrupted put-backs are read"),
        Vec::new()
    );
}

// A crash between the discard's retirement write and its record removal leaves git's record and
// the tree's refs in the repository's refs payload. Kills a cleanup that removes the record but
// leaves the refs, whose name every later put-back's counter would skip.
#[tokio::test]
async fn a_cleanup_removes_a_crash_left_record_with_its_refs_in_a_refs_payload() {
    let fixture = KeptCopyFixture::new().await;
    // The repository's refs move to the payload, as a repository made with one would hold them.
    let payload = fixture.repository.join("payload");
    fs::create_dir_all(payload.join("refs/heads")).expect("the payload's refs are made");
    fs::create_dir_all(payload.join("worktrees")).expect("the payload's tree refs are made");
    let main = fixture
        .git(&fixture.repository, &["rev-parse", "main"])
        .await;
    fs::write(payload.join("refs/heads/main"), format!("{main}\n")).expect("main is written");
    fs::write(payload.join("HEAD"), "ref: refs/heads/main\n").expect("HEAD is written");
    for setting in [
        ["config", "core.repositoryformatversion", "1"],
        ["config", "extensions.refStorage", "files://../payload"],
    ] {
        fixture.git(&fixture.repository, &setting).await;
    }
    let tree = fixture.add_tree("fix", "fix").await;
    let removed_worktree_id = fixture.discard(&tree).await;
    let refs_folder = payload.join("worktrees/fix");
    assert!(refs_folder.exists(), "the crash left the tree's refs");
    let record = fixture.common_folder().join("worktrees/fix");
    fs::create_dir_all(&record).expect("the crash left the record");
    fs::write(
        record.join("gitdir"),
        format!(
            "{}\n",
            Path::new(tree.fs_root.as_str()).join(".git").display()
        ),
    )
    .expect("the record names the tree");

    fixture
        .store
        .remove_stale_record_of(removed_worktree_id)
        .await
        .expect("the cleanup removes what the crash left");

    assert!(!record.exists(), "the record is left");
    assert!(!refs_folder.exists(), "the tree's refs are left");
}
