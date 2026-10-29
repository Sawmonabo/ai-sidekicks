use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use notify::NullWatcher;
use rusqlite::{Connection, params};
use sidekicks_contracts::git::shared::GitRefName;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::repo::mount::{ExecutionMode, RepoMountId, WorkspaceId};
use sidekicks_contracts::repo::workspace::WorkspaceBindRequest;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::worktree::lifecycle::{WorkspaceExecutionRootPrepareRequest, WorktreeId};
use sidekicks_ipc::registry::HandlerError;
use sidekicks_platforms::{Spawner, real_path};
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_run_id};
use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log};
use tempfile::TempDir;

use super::{
    ExecutionRootError, ExecutionRootService, ExecutionRootServiceDeps, PreparedExecutionRoot,
};
use crate::event_emitter::WorkspaceEventEmitter;
use crate::git::process::test_repository::{git_in, make_test_repository};
use crate::git::process::{GitLimits, GitRunner, test_git_runner};
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
use crate::test_rows::{PARENT_ROWS_AT, project_and_mount_rows};

const SESSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e80";
const MOUNT_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e81";
const WORKSPACE_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e82";
const DAEMON_TREE_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e83";

// Far past any git call these tests make, so only a preparation waiting on itself reaches it.
const DEADLOCK_BOUND: Duration = Duration::from_secs(60);

const READ_STATEMENT_CAPACITY: usize = 32;

/// The execution roots over a test database holding the session `SESSION_ID` and the attached
/// mount `MOUNT_ID` of the repository `app` on `main`, every path resolved.
struct ExecutionRootFixture {
    _database: TestDatabase,
    _log: TestLog,
    scratch: TempDir,
    git: GitRunner,
    repository: PathBuf,
    rows: Connection,
    workspaces: Arc<WorkspaceService>,
    service: ExecutionRootService<NullWatcher>,
}

impl ExecutionRootFixture {
    /// The fixture whose every git call goes through `git`, its repository made with the test's
    /// own git.
    async fn with_git(git: GitRunner) -> Self {
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
        let service = ExecutionRootService::new(ExecutionRootServiceDeps {
            writer: Arc::clone(&log.writer),
            reads,
            git: git.clone(),
            workspaces: Arc::clone(&workspaces),
            worktrees,
            creator,
            setup,
        });
        Self {
            _database: database,
            _log: log,
            scratch,
            git: test_git_runner(),
            repository,
            rows,
            workspaces,
            service,
        }
    }

    async fn new() -> Self {
        Self::with_git(test_git_runner()).await
    }

    /// Binds the session to the repository as a `boundRoot` checkout, which lands `preparing`.
    async fn bind(&self) -> WorkspaceId {
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
    async fn add_tree(&self, branch: &str) -> PathBuf {
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
    fn workspace(&self, workspace_id: WorkspaceId) -> StoredWorkspace {
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

    fn count(&self, sql: &str) -> i64 {
        self.rows
            .query_row(sql, [], |row| row.get(0))
            .expect("the test counts rows")
    }

    async fn prepare(
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

    async fn move_to(
        &self,
        workspace_id: WorkspaceId,
        folder: &Path,
    ) -> Result<PreparedExecutionRoot, ExecutionRootError> {
        let hold = self.service.hold_preparation(workspace_id).await;
        self.service.move_to_folder_held(&hold, folder).await
    }
}

#[derive(Debug, PartialEq, Eq)]
struct StoredWorkspace {
    state: String,
    execution_mode: String,
    last_error: Option<String>,
    bound_root: Option<String>,
}

fn refusal_code(error: ExecutionRootError) -> RefusalCode {
    match HandlerError::from(error) {
        HandlerError::Refused(refusal) => refusal.code,
        other => panic!("the call is refused, not {other:?}"),
    }
}

#[tokio::test]
async fn a_wire_prepare_of_a_worktree_with_no_branch_is_refused_before_any_git_call() {
    // Catches the branch check moved after the creator: with no git to run, the creator's first
    // call fails and the answer is `worktree.createFailed`, not `workspace.branchNameRequired`.
    let no_git = GitRunner::new(
        Spawner::new(tokio::runtime::Handle::current()).expect("the spawner thread starts"),
        None,
        Arc::from(Vec::new()),
        GitLimits::DAEMON,
    );
    let fixture = ExecutionRootFixture::with_git(no_git).await;
    let root = fixture.repository.to_string_lossy();
    fixture
        .rows
        .execute(
            "INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, fs_root, \
             state, metadata, created_at, updated_at) VALUES (?1, ?2, ?3, 'provisionedWorktree', \
             ?4, 'ready', json_object('boundRoot', ?4, 'checkoutRoot', ?4), ?5, ?5)",
            params![WORKSPACE_ID, SESSION_ID, MOUNT_ID, root, PARENT_ROWS_AT],
        )
        .expect("the workspace is stored");
    let workspace_id = WorkspaceId::new(WORKSPACE_ID).expect("the id is a UUID");

    let refused = fixture
        .prepare(workspace_id, None)
        .await
        .expect_err("a worktree prepare with no branch is refused");

    assert_eq!(
        refusal_code(refused),
        RefusalCode::WorkspaceBranchNameRequired
    );
    assert_eq!(fixture.workspace(workspace_id).state, "ready");
    assert_eq!(fixture.count("SELECT count(*) FROM session_events"), 0);
    assert_eq!(fixture.count("SELECT count(*) FROM worktrees"), 0);
}

#[tokio::test]
async fn a_branch_git_refuses_parks_the_workspace_root_lost_with_the_refusal_as_its_last_error() {
    // Catches the failure path skipping the bracket's failure record: the workspace would stay
    // `preparing` with no `lastError`.
    let fixture = ExecutionRootFixture::new().await;
    let workspace_id = fixture.bind().await;

    let refused = fixture
        .prepare(workspace_id, Some("bad..name"))
        .await
        .expect_err("git refuses the branch name");

    assert_eq!(refusal_code(refused), RefusalCode::WorktreeCreateFailed);
    let stored = fixture.workspace(workspace_id);
    assert_eq!(stored.state, "rootLost");
    let last_error = stored.last_error.expect("the failure is recorded");
    assert!(
        last_error.starts_with("worktree.createFailed: "),
        "the recorded failure names its refusal: {last_error}"
    );
    assert_eq!(fixture.count("SELECT count(*) FROM branch_contexts"), 0);
}

#[tokio::test]
async fn a_move_binds_a_person_made_tree_as_a_checkout_and_keeps_one_context_per_daemon_tree() {
    // Catches the worktree context written with a plain insert: the second move into the daemon's
    // tree would meet the unique index on its pair and fail.
    let fixture = ExecutionRootFixture::new().await;
    let workspace_id = fixture.bind().await;
    let daemon_tree = fixture.add_tree("daemon-made").await;
    fixture
        .rows
        .execute(
            "INSERT INTO worktrees (id, repo_mount_id, created_by_session_id, branch_name, \
             base_ref, fs_root, state, created_at, updated_at) VALUES (?1, ?2, ?3, \
             'daemon-made', 'main', ?4, 'ready', ?5, ?5)",
            params![
                DAEMON_TREE_ID,
                MOUNT_ID,
                SESSION_ID,
                daemon_tree.to_string_lossy(),
                PARENT_ROWS_AT
            ],
        )
        .expect("the daemon's tree is recorded");
    let person_tree = fixture.add_tree("person-made").await;
    let daemon_tree_id = WorktreeId::new(DAEMON_TREE_ID).expect("the id is a UUID");

    let first = fixture
        .move_to(workspace_id, &daemon_tree)
        .await
        .expect("the move into the daemon's tree lands");
    assert_eq!(first.execution_mode, ExecutionMode::ProvisionedWorktree);
    assert_eq!(first.worktree_id, Some(daemon_tree_id));

    let person = fixture
        .move_to(workspace_id, &person_tree)
        .await
        .expect("the move into the person's tree lands");
    assert_eq!(person.execution_mode, ExecutionMode::BoundRoot);
    assert_eq!(person.worktree_id, None);
    assert_eq!(person.execution_root, person_tree);
    let stored = fixture.workspace(workspace_id);
    assert_eq!(stored.execution_mode, "boundRoot");
    assert_eq!(
        stored.bound_root.as_deref(),
        Some(person_tree.to_string_lossy().as_ref())
    );

    let again = fixture
        .move_to(workspace_id, &daemon_tree)
        .await
        .expect("the second move into the daemon's tree lands");
    assert_eq!(again.branch_context_id, first.branch_context_id);
    assert_eq!(
        fixture.count(&format!(
            "SELECT count(*) FROM branch_contexts WHERE worktree_id = '{DAEMON_TREE_ID}' \
             AND workspace_id = '{workspace_id}'"
        )),
        1
    );
    assert_eq!(fixture.workspace(workspace_id).state, "ready");
}

#[tokio::test]
async fn work_under_one_preparation_hold_never_waits_on_that_hold() {
    // Catches a held form taking the preparation lock again: it would wait on the caller's own
    // hold and never finish.
    let fixture = ExecutionRootFixture::new().await;
    let workspace_id = fixture.bind().await;
    let person_tree = fixture.add_tree("person-made").await;

    let held = tokio::time::timeout(DEADLOCK_BOUND, async {
        let hold = fixture.service.hold_preparation(workspace_id).await;
        let prepared = fixture
            .service
            .prepare_for_run_held(&hold, test_run_id(), None)
            .await
            .expect("the run's prepare binds the stored folder");
        let moved = fixture
            .service
            .move_to_folder_held(&hold, &person_tree)
            .await
            .expect("the move under the same hold lands");
        (prepared, moved)
    })
    .await
    .expect("no held form waits on the caller's hold");

    let (prepared, moved) = held;
    assert_eq!(prepared.execution_root, fixture.repository);
    assert_eq!(moved.execution_root, person_tree);
    assert_eq!(fixture.workspace(workspace_id).state, "ready");
}
