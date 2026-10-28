//! A repository with a mount and the kept worktrees' store over it, for the tests of the store and
//! of the put-back: trees added with git, discarded as the removal discards them and put back.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::params;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::git::shared::GitRefName;
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_contracts::worktree::copy_progress::WorktreeCopy;
use sidekicks_contracts::worktree::lifecycle::{RemovedWorktreeId, WorktreeId, WorktreeState};
use sidekicks_contracts::worktree::removed::WorktreeRestoreResponse;
use sidekicks_platforms::real_path;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log};
use tempfile::TempDir;

use super::rows::{KeptWorktreeRecord, finish_statement};
use super::{
    REMOVED_WORKTREE_STORE_STATEMENT_CAPACITY, RemovedWorktreeStore, RemovedWorktreeStoreDeps,
    kept_folder_for,
};
use crate::git::process::test_repository::{commit_empty, git_in, make_test_repository};
use crate::git::process::{GitRunner, test_git_runner};
use crate::git::worktree::copy::progress::WorktreeCopiesUnderWay;
use crate::git::worktree::event_emitter::WorktreeEventEmitter;
use crate::git::worktree::kept_copy::folder_move::FolderMoveTools;
use crate::git::worktree::kept_copy::{KeptCopyTools, WorktreeAside, move_worktree_aside};
use crate::git::worktree::occupancy::MountOccupancyReader;
use crate::git::worktree::path_holds::PathHolds;
use crate::git::worktree::removal::new_removed_worktree_id;
use crate::git::worktree::rows::WorktreeRow;
use crate::git::worktree::schema::schema_parts;
use crate::git::worktree::service::{
    RecordRetirementOptions, WorktreeService, WorktreeServiceDeps,
};
use crate::test_rows::{PARENT_ROWS_AT, project_and_mount_rows};

// The worktree service's statements beside the store's.
const READ_STATEMENT_CAPACITY: usize = 16 + REMOVED_WORKTREE_STORE_STATEMENT_CAPACITY;

/// A repository `app` with one commit on `main`, its project and mount, and the store, keeping
/// trees under `worktrees/app/`.
pub(crate) struct KeptCopyFixture {
    /// The test database.
    pub(crate) database: TestDatabase,
    _log: TestLog,
    // The scratch folder the fixture made for itself, removed when dropped.
    _scratch: Option<TempDir>,
    /// The git runner every call goes through.
    pub(crate) git: GitRunner,
    /// The repository's main checkout, resolved.
    pub(crate) repository: PathBuf,
    /// The daemon's worktrees folder.
    pub(crate) worktrees_folder: PathBuf,
    /// The project's mount, whose id is also the project's.
    pub(crate) mount: String,
    /// The worktree service the store records put-back trees through.
    pub(crate) worktrees: Arc<WorktreeService>,
    /// The store under test.
    pub(crate) store: Arc<RemovedWorktreeStore>,
    copies: WorktreeCopiesUnderWay,
    names_in_use: Arc<PathHolds>,
}

impl KeptCopyFixture {
    /// The fixture in a scratch folder of its own, its repository made and its mount stored.
    pub(crate) async fn new() -> Self {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let mut fixture = Self::in_folder(scratch.path()).await;
        fixture._scratch = Some(scratch);
        fixture
    }

    /// The fixture built under `root`, which the caller keeps and removes.
    pub(crate) async fn in_folder(root: &Path) -> Self {
        let database = TestDatabase::new(schema_parts());
        let log = open_log(&database, None).await;
        // Resolved, since git writes every record from the resolved path.
        let scratch_path = real_path(root).expect("the scratch folder resolves");
        let git = test_git_runner();
        let repository = make_test_repository(&git, &scratch_path, "app").await;
        let mount = mint_uuid_v7().to_string();
        let connection = database.reader();
        for row in project_and_mount_rows(&mount, None) {
            connection
                .execute_batch(&row)
                .expect("the project and its mount are stored");
        }
        connection
            .execute(
                "UPDATE repo_mounts SET canonical_root = ?1, \
                 metadata = json_object('commonDir', ?2) WHERE id = ?3",
                params![
                    repository.to_string_lossy(),
                    repository.join(".git").to_string_lossy(),
                    mount
                ],
            )
            .expect("the mount points at the repository");
        let reads = Arc::new(DatabaseReadPool::new(
            database.path(),
            READ_STATEMENT_CAPACITY,
        ));
        let worktrees_folder = scratch_path.join("worktrees");
        let worktrees = Arc::new(WorktreeService::new(WorktreeServiceDeps {
            git: git.clone(),
            reads: Arc::clone(&reads),
            writer: Arc::clone(&log.writer),
            events: Arc::new(WorktreeEventEmitter::new(Arc::clone(&log.service))),
            occupancy: MountOccupancyReader::new(Arc::clone(&reads)),
            worktrees_folder: worktrees_folder.clone(),
        }));
        let copies = WorktreeCopiesUnderWay::default();
        let names_in_use = Arc::new(PathHolds::default());
        let store = Arc::new(RemovedWorktreeStore::new(RemovedWorktreeStoreDeps {
            git: git.clone(),
            reads,
            writer: Arc::clone(&log.writer),
            worktrees: Arc::clone(&worktrees),
            copies: copies.clone(),
            names_in_use: Arc::clone(&names_in_use),
            kept_copy_lock: Arc::new(KeyedLock::new()),
            worktrees_folder: worktrees_folder.clone(),
        }));
        Self {
            database,
            _log: log,
            _scratch: None,
            git,
            repository,
            worktrees_folder,
            mount,
            worktrees,
            store,
            copies,
            names_in_use,
        }
    }

    /// The folder of the tree `name`.
    pub(crate) fn tree_at(&self, name: &str) -> PathBuf {
        self.worktrees_folder.join("app").join(name)
    }

    /// The repository's git common folder.
    pub(crate) fn common_folder(&self) -> PathBuf {
        self.repository.join(".git")
    }

    /// Runs git in `folder` and answers its output, trimmed.
    pub(crate) async fn git(&self, folder: &Path, arguments: &[&str]) -> String {
        git_in(&self.git, folder, arguments).await
    }

    /// Commits everything staged in `folder` as `message`.
    pub(crate) async fn commit(&self, folder: &Path, message: &str) {
        commit_empty(&self.git, folder, message).await;
    }

    /// A linked tree on a new branch `branch` at the tree folder `name`, with its live row.
    pub(crate) async fn add_tree(&self, name: &str, branch: &str) -> WorktreeRow {
        let folder = self.tree_at(name);
        self.git(
            &self.repository,
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                branch,
                &folder.to_string_lossy(),
            ],
        )
        .await;
        let worktree_id = mint_uuid_v7().to_string();
        let session_id = mint_uuid_v7().to_string();
        self.database
            .reader()
            .execute(
                "INSERT INTO worktrees (id, repo_mount_id, created_by_session_id, branch_name, \
                 base_ref, fs_root, state, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, 'main', ?5, ?6, ?7, ?7)",
                params![
                    worktree_id,
                    self.mount,
                    session_id,
                    branch,
                    folder.to_string_lossy(),
                    <&'static str>::from(WorktreeState::Ready),
                    PARENT_ROWS_AT,
                ],
            )
            .expect("the worktree is stored");
        WorktreeRow {
            id: WorktreeId::new(&worktree_id).expect("a minted id is a worktree id"),
            repo_mount_id: RepoMountId::new(&self.mount).expect("a minted id is a mount id"),
            created_by_session_id: SessionId::new(&session_id)
                .expect("a minted id is a session id"),
            branch_name: GitRefName::new(branch.to_owned()).expect("a branch name"),
            base_ref: GitRefName::new("main".to_owned()).expect("a base name"),
            fs_root: FilesystemPath::new(folder.to_string_lossy().into_owned())
                .expect("a tree's folder"),
            state: WorktreeState::Ready,
        }
    }

    /// Discards `tree` as the removal does: its kept copy moved aside through the store's row
    /// writes, its retirement recorded with the copy listed, and git's record of it removed.
    pub(crate) async fn discard(&self, tree: &WorktreeRow) -> RemovedWorktreeId {
        let removed_worktree_id = new_removed_worktree_id();
        let kept_folder = kept_folder_for(tree, &removed_worktree_id);
        let tree_folder = PathBuf::from(tree.fs_root.as_str());
        let name = tree_folder
            .file_name()
            .expect("a tree's folder has a name")
            .to_string_lossy()
            .into_owned();
        let copy = WorktreeCopy::Removing {
            worktree_id: tree.id,
            project_id: ProjectId::new(&self.mount).expect("the project's id"),
            name: FreeFormText::new(name).expect("a tree's name"),
            copied_bytes: SafeInt::ZERO,
            total_bytes: SafeInt::ZERO,
        };
        let row_writes = self.store.pending_kept_copy(KeptWorktreeRecord {
            removed_worktree_id,
            worktree: tree.clone(),
            kept_folder: kept_folder.clone(),
        });
        let moved = move_worktree_aside(
            KeptCopyTools {
                git: &self.git,
                place: None,
                folder_moves: FolderMoveTools {
                    copies: &self.copies,
                    names_in_use: &self.names_in_use,
                },
            },
            WorktreeAside {
                tree_folder: &tree_folder,
                kept_folder: &kept_folder,
                removed_worktree_id: &removed_worktree_id,
                copy: &copy,
            },
            &row_writes,
        )
        .await
        .expect("the tree moves aside");
        self.worktrees
            .record_retirement(
                tree,
                RecordRetirementOptions {
                    removed_worktree_id: Some(removed_worktree_id),
                    transactional_prelude: vec![finish_statement(&removed_worktree_id)],
                    ..RecordRetirementOptions::default()
                },
            )
            .await
            .expect("the retirement is recorded");
        self.worktrees
            .remove_worktree_record(Some(&moved.state.record_folder))
            .await
            .expect("git's record of the tree is removed");
        removed_worktree_id
    }

    /// Puts the kept copy back, answering the restored tree's folder and branch and whether the
    /// branch is new.
    pub(crate) async fn restore(
        &self,
        removed_worktree_id: RemovedWorktreeId,
    ) -> (PathBuf, String, bool) {
        match self
            .store
            .restore(removed_worktree_id)
            .await
            .expect("the put-back runs")
        {
            WorktreeRestoreResponse::Restored {
                path,
                branch,
                on_new_branch,
                ..
            } => (
                PathBuf::from(path.as_str()),
                branch.as_str().to_owned(),
                on_new_branch,
            ),
            WorktreeRestoreResponse::Refused { refusal } => {
                unreachable!("the put-back was refused: {refusal:?}")
            }
        }
    }

    /// The kept folder `removed_worktree_id` names on its row.
    pub(crate) fn kept_folder(&self, removed_worktree_id: &RemovedWorktreeId) -> PathBuf {
        self.database
            .reader()
            .query_row(
                "SELECT kept_path FROM removed_worktrees WHERE id = ?1",
                [removed_worktree_id.to_string()],
                |row| row.get::<_, String>(0),
            )
            .map(PathBuf::from)
            .expect("the kept copy's row is read")
    }
}
