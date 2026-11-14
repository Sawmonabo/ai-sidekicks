//! The execution roots over a test database, for the tests of the execution roots and of the
//! services built on them, in this crate and others: the session [`SESSION_ID`] and the attached
//! mount [`MOUNT_ID`] of the repository `app` on `main`, every path resolved, and the run setup
//! gate built over them.

use std::error::Error;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use notify::NullWatcher;
use rusqlite::{Connection, params};
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::git::shared::GitRefName;
use sidekicks_contracts::repo::mount::{ExecutionMode, RepoMountId, WorkspaceId};
use sidekicks_contracts::repo::workspace::WorkspaceBindRequest;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::worktree::lifecycle::RunningHolder;
use sidekicks_contracts::worktree::lifecycle::WorkspaceExecutionRootPrepareRequest;
use sidekicks_platforms::real_path;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::database::schema::SchemaParts;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log};
use sidekicks_store::events::session::append_lock::SessionAppendHold;
use tempfile::TempDir;

use super::{
    ExecutionRootError, ExecutionRootService, ExecutionRootServiceDeps, PreparedExecutionRoot,
    WorkspacePreparationHold,
};
use crate::event_emitter::WorkspaceEventEmitter;
use crate::git::process::test_repository::{git_in, make_test_repository};
use crate::git::process::{GitRunner, test_git_runner};
use crate::git::turn_snapshot::capture::GitFloorReports;
use crate::git::turn_snapshot::repack::CapturePacking;
use crate::git::worktree::creation::test_sources::{FixedNaming, NoSetupSteps, ScriptedLiveRuns};
use crate::git::worktree::creation::{WorktreeCreator, WorktreeCreatorDeps};
use crate::git::worktree::event_emitter::WorktreeEventEmitter;
use crate::git::worktree::naming::WorktreeNaming;
use crate::git::worktree::occupancy::MountOccupancyReader;
use crate::git::worktree::schema::schema_parts;
use crate::git::worktree::service::{WorktreeService, WorktreeServiceDeps};
use crate::git::worktree::setup::test_runner::test_setup_runner;
use crate::project::list_feed::ProjectListFeed;
use crate::project::records::{ProjectRecords, ProjectSessionActivity};
use crate::repo::mount::reattach::{
    RepoMountReattachService, RepoMountReattachServiceDeps, RunningHolderLookup,
    RunningHolderLookupError,
};
use crate::repo::root_resolver::RepoRootResolver;
use crate::run_setup_gates::execution_root::{
    ExecutionRootSetupGate, ExecutionRootSetupGateDeps, SessionFolderMoves,
};
use crate::service::{WorkspaceService, WorkspaceServiceDeps};
use crate::test_rows::project_and_mount_rows;

/// The session the fixture stores.
pub const SESSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e80";
/// The attached mount the fixture stores, at the repository.
pub const MOUNT_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e81";

const READ_STATEMENT_CAPACITY: usize = 32;

/// The agent every agent run reads as.
pub const RUNNING_AGENT_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4ea1";

/// The execution roots over a test database holding the session `SESSION_ID` and the attached
/// mount `MOUNT_ID` of the repository `app` on `main`, every path resolved.
pub struct ExecutionRootFixture {
    /// The database, kept open while the fixture lives.
    pub database: TestDatabase,
    /// The event log and writer on the database.
    pub log: TestLog,
    /// The scratch folder the repository and its trees sit in.
    pub scratch: TempDir,
    /// The test's own git, for the trees a test makes by hand.
    pub git: GitRunner,
    /// The repository, resolved.
    pub repository: PathBuf,
    /// A connection for the rows a test stores and reads by hand.
    pub rows: Connection,
    /// The read pool every service reads through.
    pub reads: Arc<DatabaseReadPool>,
    /// The workspace lifecycle.
    pub workspaces: Arc<WorkspaceService>,
    /// The execution roots.
    pub service: Arc<ExecutionRootService<NullWatcher>>,
}

impl ExecutionRootFixture {
    /// The fixture over a database made from `schema`, which holds at least the worktree tables,
    /// whose every git call goes through `git`, its repository made with the test's own git.
    pub async fn with(schema: SchemaParts, git: GitRunner) -> Self {
        let database = TestDatabase::new(schema);
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
            Arc::clone(&log.writer),
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
            database,
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

    /// The fixture over the worktree tables and the test's own git.
    pub async fn new() -> Self {
        Self::with(schema_parts(), test_git_runner()).await
    }

    /// Binds the session to the repository as a `boundRoot` checkout, which lands `preparing`.
    pub async fn bind(&self) -> WorkspaceId {
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
    pub async fn add_tree(&self, branch: &str) -> PathBuf {
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
    pub fn workspace(&self, workspace_id: WorkspaceId) -> StoredWorkspace {
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

    /// The count `sql` reads.
    pub fn count(&self, sql: &str) -> i64 {
        self.rows
            .query_row(sql, [], |row| row.get(0))
            .expect("the test counts rows")
    }

    /// The wire's prepare of `workspace_id` under its own hold, naming `branch_name` when given.
    pub async fn prepare(
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

    /// The session's stand-in working-folder moves over these execution roots.
    pub fn stand_in_moves(&self) -> Arc<StandInMoves> {
        Arc::new(StandInMoves {
            execution_roots: Arc::clone(&self.service),
            pending: Mutex::new(None),
            sweeps: AtomicUsize::new(0),
        })
    }

    /// The run setup gate over these execution roots, driving `moves`, its projects list counting
    /// each project's sessions through `sessions`, its mount recording the repository's common
    /// folder as its anchor.
    pub fn setup_gate(
        &self,
        moves: Arc<dyn SessionFolderMoves>,
        sessions: Arc<dyn ProjectSessionActivity>,
    ) -> ExecutionRootSetupGate<NullWatcher> {
        self.rows
            .execute(
                "UPDATE repo_mounts SET metadata = json_set(metadata, '$.commonDir', ?1) \
                 WHERE id = ?2",
                params![self.repository.join(".git").to_string_lossy(), MOUNT_ID],
            )
            .expect("the mount records its anchor");
        let reattach = Arc::new(RepoMountReattachService::new(
            RepoMountReattachServiceDeps {
                writer: Arc::clone(&self.log.writer),
                reads: Arc::clone(&self.reads),
                workspaces: Arc::clone(&self.workspaces),
                execution_roots: Arc::clone(&self.service),
                events: Arc::new(WorkspaceEventEmitter::new(Arc::clone(&self.log.service))),
                worktree_events: Arc::new(WorktreeEventEmitter::new(Arc::clone(&self.log.service))),
                resolver: RepoRootResolver::new(test_git_runner()),
                holders: Arc::new(RunsTableHolders {
                    reads: Arc::clone(&self.reads),
                }),
                packing: Arc::new(CapturePacking::new(
                    test_git_runner(),
                    Arc::new(GitFloorReports::default()),
                )),
                data_folder: self.scratch.path().join("data"),
                common_folder_columns: Vec::new(),
                attach_notice: Arc::default(),
            },
        ));
        let records = Arc::new(ProjectRecords::new(Arc::clone(&self.reads), sessions));
        ExecutionRootSetupGate::new(ExecutionRootSetupGateDeps {
            writer: Arc::clone(&self.log.writer),
            reads: Arc::clone(&self.reads),
            git: test_git_runner(),
            workspaces: Arc::clone(&self.workspaces),
            execution_roots: Arc::clone(&self.service),
            reattach,
            moves,
            checkout_lock: Arc::new(KeyedLock::new()),
            list_feed: Arc::new(ProjectListFeed::new(records, &self.log.followers)),
        })
    }

    /// Moves `workspace_id` into `folder` under its own hold.
    pub async fn move_to(
        &self,
        workspace_id: WorkspaceId,
        folder: &Path,
    ) -> Result<PreparedExecutionRoot, ExecutionRootError> {
        let hold = self.service.hold_preparation(workspace_id).await;
        self.service.move_to_folder_held(&hold, folder, None).await
    }

    /// Puts a new repository in the mount's folder, its git folder kept beside it, so the mount
    /// reads `identityMismatch`, and answers that git folder. One made in place at the same path
    /// would hold the anchor's own common folder and read as the same repository.
    pub async fn replace_repository(&self) -> PathBuf {
        std::fs::remove_dir_all(&self.repository).expect("the old repository goes");
        let parent = self
            .repository
            .parent()
            .expect("the repository sits in the scratch folder");
        let repository = make_test_repository(&self.git, parent, "app").await;
        let common_folder = parent.join("app-replacement.git");
        git_in(
            &self.git,
            &repository,
            &[
                "init",
                "--quiet",
                "--separate-git-dir",
                &common_folder.to_string_lossy(),
            ],
        )
        .await;
        common_folder
    }
}

/// A workspace's row as a test reads it back.
#[derive(Debug, PartialEq, Eq)]
pub struct StoredWorkspace {
    /// Its state.
    pub state: String,
    /// Its execution mode.
    pub execution_mode: String,
    /// Its `lastError`.
    pub last_error: Option<String>,
    /// Its `boundRoot`.
    pub bound_root: Option<String>,
}

/// Reads a run in the session crate's `runs` table as an agent's run for [`RUNNING_AGENT_ID`],
/// and any other as a workflow run, as the session crate's lookup tells them apart; only a test
/// whose schema holds `runs` re-attaches through it.
struct RunsTableHolders {
    reads: Arc<DatabaseReadPool>,
}

impl RunningHolderLookup for RunsTableHolders {
    fn read_running_holder<'a>(
        &'a self,
        _session_id: &'a SessionId,
        run_id: &'a str,
    ) -> BoxFuture<'a, Result<RunningHolder, RunningHolderLookupError>> {
        let run_id = run_id.to_owned();
        async move {
            let is_agent_run = self
                .reads
                .read(ReadLength::Short, {
                    let run_id = run_id.clone();
                    move |connection| {
                        connection
                            .query_row(
                                "SELECT EXISTS (SELECT 1 FROM runs WHERE run_id = ?1)",
                                [&run_id],
                                |row| row.get::<_, bool>(0),
                            )
                            .map_err(|error| Box::new(error) as Box<dyn Error + Send + Sync>)
                    }
                })
                .await
                .map_err(RunningHolderLookupError)?;
            Ok(if is_agent_run {
                RunningHolder::Agent {
                    agent_id: AgentId::new(RUNNING_AGENT_ID).expect("the id is a UUID"),
                }
            } else {
                RunningHolder::WorkflowRun {
                    run_id: WorkflowRunId::new(&run_id).expect("a workflow run's id is a UUID"),
                }
            })
        }
        .boxed()
    }
}

/// Stands in for the session's working-folder moves: a pending move is applied under the gate's
/// hold through the execution roots' held move, as the session crate applies one; sweeps are
/// counted.
pub struct StandInMoves {
    execution_roots: Arc<ExecutionRootService<NullWatcher>>,
    /// The folder the next held move applies, taken when it is applied.
    pub pending: Mutex<Option<PathBuf>>,
    /// How many sweeps were asked for.
    pub sweeps: AtomicUsize,
}

impl SessionFolderMoves for StandInMoves {
    fn apply_pending_held<'a>(
        &'a self,
        _session_id: &'a SessionId,
        hold: &'a WorkspacePreparationHold<'_>,
    ) -> BoxFuture<'a, Result<(), Box<dyn Error + Send + Sync>>> {
        let pending = lock(&self.pending).take();
        async move {
            if let Some(folder) = pending {
                self.execution_roots
                    .move_to_folder_held(hold, &folder, None)
                    .await?;
            }
            Ok(())
        }
        .boxed()
    }

    fn apply_pending<'a>(
        &'a self,
        _session_id: &'a SessionId,
        _hold: Option<&'a SessionAppendHold>,
    ) -> BoxFuture<'a, Result<(), Box<dyn Error + Send + Sync>>> {
        async { Ok(()) }.boxed()
    }

    fn sweep_from_removed_tree<'a>(
        &'a self,
        _session_id: &'a SessionId,
        _hold: Option<&'a SessionAppendHold>,
    ) -> BoxFuture<'a, Result<(), Box<dyn Error + Send + Sync>>> {
        self.sweeps.fetch_add(1, Ordering::SeqCst);
        async { Ok(()) }.boxed()
    }
}
