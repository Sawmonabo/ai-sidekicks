//! The execution roots over a test database, for the tests of the execution roots and of the
//! services built on them: the session [`SESSION_ID`] and the attached mount [`MOUNT_ID`] of the
//! repository `app` on `main`, every path resolved.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use notify::NullWatcher;
use rusqlite::{Connection, params};
use sidekicks_contracts::git::shared::GitRefName;
use sidekicks_contracts::repo::mount::{ExecutionMode, RepoMountId, WorkspaceId};
use sidekicks_contracts::repo::workspace::WorkspaceBindRequest;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::worktree::lifecycle::WorkspaceExecutionRootPrepareRequest;
use sidekicks_platforms::real_path;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log};
use tempfile::TempDir;

use super::{
    ExecutionRootError, ExecutionRootService, ExecutionRootServiceDeps, PreparedExecutionRoot,
};
use crate::event_emitter::WorkspaceEventEmitter;
use crate::git::process::test_repository::{git_in, make_test_repository};
use crate::git::process::{GitRunner, test_git_runner};
use crate::git::worktree::creation::test_sources::{FixedNaming, NoSetupSteps, ScriptedLiveRuns};
use crate::git::worktree::creation::{WorktreeCreator, WorktreeCreatorDeps};
use crate::git::worktree::event_emitter::WorktreeEventEmitter;
use crate::git::worktree::naming::WorktreeNaming;
use crate::git::worktree::occupancy::MountOccupancyReader;
use crate::git::worktree::schema::schema_parts;
use crate::git::worktree::service::{WorktreeService, WorktreeServiceDeps};
use crate::git::worktree::setup::test_runner::test_setup_runner;
use crate::repo::root_resolver::RepoRootResolver;
use crate::service::{WorkspaceService, WorkspaceServiceDeps};
use crate::test_rows::project_and_mount_rows;

/// The session the fixture stores.
pub(crate) const SESSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e80";
/// The attached mount the fixture stores, at the repository.
pub(crate) const MOUNT_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e81";

const READ_STATEMENT_CAPACITY: usize = 32;

/// The execution roots over a test database holding the session `SESSION_ID` and the attached
/// mount `MOUNT_ID` of the repository `app` on `main`, every path resolved.
pub(crate) struct ExecutionRootFixture {
    pub(crate) _database: TestDatabase,
    pub(crate) log: TestLog,
    pub(crate) scratch: TempDir,
    pub(crate) git: GitRunner,
    pub(crate) repository: PathBuf,
    pub(crate) rows: Connection,
    pub(crate) reads: Arc<DatabaseReadPool>,
    pub(crate) workspaces: Arc<WorkspaceService>,
    pub(crate) service: Arc<ExecutionRootService<NullWatcher>>,
}

impl ExecutionRootFixture {
    /// The fixture whose every git call goes through `git`, its repository made with the test's
    /// own git.
    pub(crate) async fn with_git(git: GitRunner) -> Self {
        let database = TestDatabase::new(schema_parts());
        let log = open_log(&database, None).await;
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let scratch_root = real_path(scratch.path()).expect("the scratch folder resolves");
        let repository = make_test_repository(&test_git_runner(), &scratch_root, "app").await;
        let rows = database.reader();
        insert_session_row(&rows, SESSION_ID, None, None);
        for row in project_and_mount_rows(MOUNT_ID, None) {
            rows.execute_batch(&row)
                .expect("the project and its mount are stored");
        }
        rows.execute(
            "UPDATE repo_mounts SET local_path = ?1, canonical_root = ?1 WHERE id = ?2",
            params![repository.to_string_lossy(), MOUNT_ID],
        )
        .expect("the mount points at the repository");

        let reads = Arc::new(DatabaseReadPool::new(
            database.path(),
            READ_STATEMENT_CAPACITY,
        ));
        let workspaces = Arc::new(WorkspaceService::new(WorkspaceServiceDeps {
            reads: Arc::clone(&reads),
            events: Arc::new(WorkspaceEventEmitter::new(Arc::clone(&log.service))),
            resolver: RepoRootResolver::new(git.clone()),
        }));
        let events = Arc::new(WorktreeEventEmitter::new(Arc::clone(&log.service)));
        let worktrees_folder = scratch_root.join("worktrees");
        let worktrees = Arc::new(WorktreeService::new(WorktreeServiceDeps {
            git: git.clone(),
            reads: Arc::clone(&reads),
            writer: Arc::clone(&log.writer),
            events: Arc::clone(&events),
            occupancy: MountOccupancyReader::new(Arc::clone(&reads)),
            worktrees_folder: worktrees_folder.clone(),
        }));
        let setup = Arc::new(test_setup_runner(
            git.clone(),
            Arc::clone(&reads),
            Arc::clone(&events),
            Arc::new(NoSetupSteps),
        ));
        let creator = Arc::new(WorktreeCreator::new(WorktreeCreatorDeps {
            git: git.clone(),
            reads: Arc::clone(&reads),
            writer: Arc::clone(&log.writer),
            events,
            naming: WorktreeNaming::new(worktrees_folder, Arc::new(FixedNaming)),
            worktrees: Arc::clone(&worktrees),
            setup: Arc::clone(&setup),
            live_run_folders: Arc::new(ScriptedLiveRuns::default()),
            checkout_lock: Arc::new(KeyedLock::new()),
        }));
        let service = Arc::new(ExecutionRootService::new(ExecutionRootServiceDeps {
            writer: Arc::clone(&log.writer),
            reads: Arc::clone(&reads),
            git: git.clone(),
            workspaces: Arc::clone(&workspaces),
            worktrees,
            creator,
            setup,
        }));
        Self {
            _database: database,
            log,
            scratch,
            git: test_git_runner(),
            repository,
            rows,
            reads,
            workspaces,
            service,
        }
    }

    pub(crate) async fn new() -> Self {
        Self::with_git(test_git_runner()).await
    }

    /// Binds the session to the repository as a `boundRoot` checkout, which lands `preparing`.
    pub(crate) async fn bind(&self) -> WorkspaceId {
        self.workspaces
            .bind(&WorkspaceBindRequest {
                session_id: SessionId::new(SESSION_ID).expect("the id is a UUID"),
                repo_mount_id: RepoMountId::new(MOUNT_ID).expect("the id is a UUID"),
                execution_mode: ExecutionMode::BoundRoot,
                directory: None,
            })
            .await
            .expect("the bind lands")
            .workspace_id
    }

    /// A tree `git worktree add` makes beside the repository on a new branch `branch`, resolved.
    pub(crate) async fn add_tree(&self, branch: &str) -> PathBuf {
        let folder = real_path(self.scratch.path())
            .expect("the scratch folder resolves")
            .join(branch);
        git_in(
            &self.git,
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
        folder
    }

    /// The workspace's state, mode, `lastError` and `boundRoot` as stored.
    pub(crate) fn workspace(&self, workspace_id: WorkspaceId) -> StoredWorkspace {
        self.rows
            .query_row(
                "SELECT state, execution_mode, json_extract(metadata, '$.lastError'), \
                 json_extract(metadata, '$.boundRoot') FROM workspaces WHERE id = ?1",
                [workspace_id.text().as_str()],
                |row| {
                    Ok(StoredWorkspace {
                        state: row.get(0)?,
                        execution_mode: row.get(1)?,
                        last_error: row.get(2)?,
                        bound_root: row.get(3)?,
                    })
                },
            )
            .expect("the workspace is read")
    }

    pub(crate) fn count(&self, sql: &str) -> i64 {
        self.rows
            .query_row(sql, [], |row| row.get(0))
            .expect("the test counts rows")
    }

    pub(crate) async fn prepare(
        &self,
        workspace_id: WorkspaceId,
        branch_name: Option<&str>,
    ) -> Result<(), ExecutionRootError> {
        let hold = self.service.hold_preparation(workspace_id).await;
        self.service
            .prepare_held(
                &hold,
                &WorkspaceExecutionRootPrepareRequest {
                    workspace_id,
                    branch_name: branch_name
                        .map(|name| GitRefName::new(name.to_owned()).expect("a branch is text")),
                    base_ref: None,
                    carry_uncommitted: None,
                },
            )
            .await
            .map(drop)
    }

    pub(crate) async fn move_to(
        &self,
        workspace_id: WorkspaceId,
        folder: &Path,
    ) -> Result<PreparedExecutionRoot, ExecutionRootError> {
        let hold = self.service.hold_preparation(workspace_id).await;
        self.service.move_to_folder_held(&hold, folder).await
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct StoredWorkspace {
    pub(crate) state: String,
    pub(crate) execution_mode: String,
    pub(crate) last_error: Option<String>,
    pub(crate) bound_root: Option<String>,
}
