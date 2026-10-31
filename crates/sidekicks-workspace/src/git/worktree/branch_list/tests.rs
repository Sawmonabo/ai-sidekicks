use std::path::Path;
use std::sync::Arc;

use rusqlite::{Connection, params};
use sidekicks_contracts::repo::mount::{ExecutionMode, RepoMountId, WorkspaceState};
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::worktree::lifecycle::{WorktreeId, WorktreeState};
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::events::log_service::test_fixture::open_log;

use super::{BranchListError, BranchListReader};
use crate::git::process::test_repository::{git_in, make_test_repository};
use crate::git::process::{GitCall, GitRunner, in_folder, test_git_runner};
use crate::git::worktree::schema::schema_parts;
use crate::repo::errors::RepoRefusal;
use crate::test_rows::{PARENT_ROWS_AT, project_and_mount_rows};

const READ_STATEMENT_CAPACITY: usize = 16;

// A listed branch's name, and the name and id of the tree holding it.
type ListedRow<'a> = (&'a str, Option<(&'a str, Option<WorktreeId>)>);

// A commit on a new branch `branch` from `main`, made at `committed_at`.
async fn branch_with_commit(git: &GitRunner, repository: &Path, branch: &str, committed_at: &str) {
    git_in(
        git,
        repository,
        &["switch", "--quiet", "-c", branch, "main"],
    )
    .await;
    commit(git, repository, committed_at).await;
}

// An empty commit on the checked-out branch, made at `committed_at`.
async fn commit(git: &GitRunner, repository: &Path, committed_at: &str) {
    let arguments = [
        "-c",
        "commit.gpgSign=false",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "work",
    ];
    git.run(
        None,
        GitCall::read(in_folder(repository, &arguments))
            .with_environment("GIT_COMMITTER_DATE", committed_at)
            .with_environment("GIT_AUTHOR_DATE", committed_at),
    )
    .await
    .expect("git commits in the test repository");
}

// A tree this daemon made at `folder` on the mount in `state`, cut from `base` at `picked_at`.
fn store_tree(
    connection: &Connection,
    mount: &str,
    folder: &Path,
    state: WorktreeState,
    base: &str,
    picked_at: &str,
) -> WorktreeId {
    let worktree_id = mint_uuid_v7().to_string();
    let workspace_id = mint_uuid_v7().to_string();
    connection
        .execute(
            "INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, fs_root, \
             state, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![
                workspace_id,
                mint_uuid_v7().to_string(),
                mount,
                <&'static str>::from(ExecutionMode::ProvisionedWorktree),
                folder.to_string_lossy(),
                <&'static str>::from(WorkspaceState::Ready),
                PARENT_ROWS_AT,
            ],
        )
        .expect("the workspace is stored");
    connection
        .execute(
            "INSERT INTO worktrees (id, repo_mount_id, created_by_session_id, branch_name, \
             base_ref, fs_root, state, created_at, updated_at) \
             VALUES (?1, ?2, 'session', ?3, ?4, ?5, ?6, ?7, ?7)",
            params![
                worktree_id,
                mount,
                folder.file_name().map(|name| name.to_string_lossy()),
                base,
                folder.to_string_lossy(),
                <&'static str>::from(state),
                PARENT_ROWS_AT,
            ],
        )
        .expect("the worktree is stored");
    connection
        .execute(
            "INSERT INTO branch_contexts (id, workspace_id, worktree_id, base_branch, \
             head_branch, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'head', ?5, ?5)",
            params![
                mint_uuid_v7().to_string(),
                workspace_id,
                worktree_id,
                base,
                picked_at
            ],
        )
        .expect("the branch context is stored");
    WorktreeId::new(&worktree_id).expect("a minted id is a worktree id")
}

// Kills: the tiers swapped, the recent bases out of order, and `held_by` naming a retired tree.
#[tokio::test]
async fn branches_list_default_then_recent_bases_then_newest_commit_with_their_holders() {
    let database = TestDatabase::new(schema_parts());
    let _log = open_log(&database, None).await;
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let git = test_git_runner();
    let repository = make_test_repository(&git, scratch.path(), "app").await;
    // The default branch has the oldest commit, and the older recent base the newest.
    commit(&git, &repository, "2026-01-01T00:00:00Z").await;
    branch_with_commit(&git, &repository, "older-base", "2026-09-01T00:00:00Z").await;
    branch_with_commit(&git, &repository, "newer-base", "2026-02-01T00:00:00Z").await;
    branch_with_commit(&git, &repository, "live-tree", "2026-06-01T00:00:00Z").await;
    branch_with_commit(&git, &repository, "retired-tree", "2026-05-01T00:00:00Z").await;
    git_in(&git, &repository, &["switch", "--quiet", "main"]).await;
    let live_folder = scratch.path().join("live");
    let retired_folder = scratch.path().join("retired");
    for (folder, branch) in [
        (&live_folder, "live-tree"),
        (&retired_folder, "retired-tree"),
    ] {
        git_in(
            &git,
            &repository,
            &[
                "worktree",
                "add",
                "--quiet",
                &folder.to_string_lossy(),
                branch,
            ],
        )
        .await;
    }

    let mount = mint_uuid_v7().to_string();
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
    let live_tree = store_tree(
        &connection,
        &mount,
        &live_folder,
        WorktreeState::Ready,
        "older-base",
        "2026-10-01T09:00:00.000Z",
    );
    store_tree(
        &connection,
        &mount,
        &retired_folder,
        WorktreeState::Retired,
        "newer-base",
        "2026-10-01T10:00:00.000Z",
    );
    let reader = BranchListReader::new(
        git,
        Arc::new(DatabaseReadPool::new(
            database.path(),
            READ_STATEMENT_CAPACITY,
        )),
    );

    let listed = reader
        .read(&RepoMountId::new(&mount).expect("a minted id is a mount id"))
        .await
        .expect("the branches are listed");

    assert_eq!(listed.default_branch.as_str(), "main");
    let rows: Vec<ListedRow<'_>> = listed
        .branches
        .iter()
        .map(|entry| {
            (
                entry.name.as_str(),
                entry
                    .held_by
                    .as_ref()
                    .map(|holder| (holder.name.as_str(), holder.worktree_id)),
            )
        })
        .collect();
    assert_eq!(
        rows,
        [
            ("main", Some(("app", None))),
            ("newer-base", None),
            ("older-base", None),
            ("live-tree", Some(("live", Some(live_tree)))),
            ("retired-tree", Some(("retired", None))),
        ]
    );
    assert_eq!(listed.counts_as_of, None);

    let unknown = RepoMountId::new(&mint_uuid_v7().to_string()).expect("a minted id");
    assert!(matches!(
        reader.read(&unknown).await,
        Err(BranchListError::Refused(RepoRefusal::MountNotFound { .. }))
    ));
}
