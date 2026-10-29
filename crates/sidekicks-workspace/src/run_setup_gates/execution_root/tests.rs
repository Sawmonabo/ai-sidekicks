use std::error::Error;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use notify::NullWatcher;
use rusqlite::params;
use serde_json::json;
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::repo::mount::{ExecutionMode, RepoMountId, WorkspaceId};
use sidekicks_contracts::repo::workspace::WorkspaceBindRequest;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::writer::test_file::test_run_id;

use super::{ExecutionRootSetupGate, ExecutionRootSetupGateDeps, SessionFolderMoves};
use crate::event_emitter::WorkspaceEventEmitter;
use crate::execution_root::test_fixture::{ExecutionRootFixture, MOUNT_ID, SESSION_ID};
use crate::execution_root::{ExecutionRootService, WorkspacePreparationHold};
use crate::git::process::test_git_runner;
use crate::git::process::test_repository::make_test_repository;
use crate::git::worktree::event_emitter::WorktreeEventEmitter;
use crate::project::list_feed::ProjectListFeed;
use crate::project::records::ProjectRecords;
use crate::project::test_doubles::NoSessions;
use crate::repo::mount::reattach::{
    RepoMountReattachService, RepoMountReattachServiceDeps, RunAgentLookup, RunAgentLookupError,
};
use crate::repo::root_resolver::RepoRootResolver;
use crate::run_setup_gates::{
    RunSetupContext, RunSetupGate, RunSetupGateError, RunTerminalContext,
};
use crate::test_rows::PARENT_ROWS_AT;

const OTHER_WORKSPACE_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4ea0";
const RUNNING_AGENT_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4ea1";

// Far past any git call these tests make, so only a binding waiting on its own hold reaches it.
const DEADLOCK_BOUND: Duration = Duration::from_secs(60);

/// Answers every run's agent; no test here re-attaches, so it is never asked.
struct AnyRunAgent;

impl RunAgentLookup for AnyRunAgent {
    fn read_run_agent<'a>(
        &'a self,
        _session_id: &'a SessionId,
        _run_id: &'a RunId,
    ) -> BoxFuture<'a, Result<AgentId, RunAgentLookupError>> {
        async { Ok(AgentId::new(RUNNING_AGENT_ID).expect("the id is a UUID")) }.boxed()
    }
}

/// Stands in for the session's working-folder moves: a pending move is applied under the gate's
/// hold through the execution roots' held move, as the session crate applies one; sweeps are
/// counted.
struct StandInMoves {
    execution_roots: Arc<ExecutionRootService<NullWatcher>>,
    pending: Mutex<Option<PathBuf>>,
    sweeps: AtomicUsize,
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
                    .move_to_folder_held(hold, &folder)
                    .await?;
            }
            Ok(())
        }
        .boxed()
    }

    fn apply_pending<'a>(
        &'a self,
        _session_id: &'a SessionId,
    ) -> BoxFuture<'a, Result<(), Box<dyn Error + Send + Sync>>> {
        async { Ok(()) }.boxed()
    }

    fn sweep_from_removed_tree<'a>(
        &'a self,
        _session_id: &'a SessionId,
    ) -> BoxFuture<'a, Result<(), Box<dyn Error + Send + Sync>>> {
        self.sweeps.fetch_add(1, Ordering::SeqCst);
        async { Ok(()) }.boxed()
    }
}

/// The gate over the execution roots' fixture, whose mount records the repository's common folder
/// as its anchor.
struct GateFixture {
    roots: ExecutionRootFixture,
    moves: Arc<StandInMoves>,
    gate: ExecutionRootSetupGate<NullWatcher>,
}

impl GateFixture {
    async fn new() -> Self {
        let roots = ExecutionRootFixture::new().await;
        roots
            .rows
            .execute(
                "UPDATE repo_mounts SET metadata = json_set(metadata, '$.commonDir', ?1) \
                 WHERE id = ?2",
                params![roots.repository.join(".git").to_string_lossy(), MOUNT_ID],
            )
            .expect("the mount records its anchor");
        let reattach = Arc::new(RepoMountReattachService::new(
            RepoMountReattachServiceDeps {
                writer: Arc::clone(&roots.log.writer),
                reads: Arc::clone(&roots.reads),
                workspaces: Arc::clone(&roots.workspaces),
                execution_roots: Arc::clone(&roots.service),
                events: Arc::new(WorkspaceEventEmitter::new(Arc::clone(&roots.log.service))),
                worktree_events: Arc::new(WorktreeEventEmitter::new(Arc::clone(
                    &roots.log.service,
                ))),
                resolver: RepoRootResolver::new(test_git_runner()),
                agents: Arc::new(AnyRunAgent),
            },
        ));
        let moves = Arc::new(StandInMoves {
            execution_roots: Arc::clone(&roots.service),
            pending: Mutex::new(None),
            sweeps: AtomicUsize::new(0),
        });
        let records = Arc::new(ProjectRecords::new(
            Arc::clone(&roots.reads),
            Arc::new(NoSessions),
        ));
        let gate = ExecutionRootSetupGate::new(ExecutionRootSetupGateDeps {
            writer: Arc::clone(&roots.log.writer),
            reads: Arc::clone(&roots.reads),
            git: test_git_runner(),
            workspaces: Arc::clone(&roots.workspaces),
            execution_roots: Arc::clone(&roots.service),
            reattach,
            moves: Arc::clone(&moves) as _,
            checkout_lock: Arc::new(KeyedLock::new()),
            list_feed: Arc::new(ProjectListFeed::new(records, &roots.log.followers)),
        });
        Self { roots, moves, gate }
    }

    /// Binds the session to the repository in `execution_mode`, which lands `preparing`.
    async fn bind(&self, execution_mode: ExecutionMode) -> WorkspaceId {
        self.roots
            .workspaces
            .bind(&WorkspaceBindRequest {
                session_id: session_id(),
                repo_mount_id: RepoMountId::new(MOUNT_ID).expect("the id is a UUID"),
                execution_mode,
                directory: None,
            })
            .await
            .expect("the bind lands")
            .workspace_id
    }

    /// The gate's check of `context`, failing the test when it waits past the deadlock bound.
    async fn assert_ready(&self, context: &RunSetupContext) -> Result<(), RunSetupGateError> {
        tokio::time::timeout(DEADLOCK_BOUND, self.gate.assert_run_ready(context))
            .await
            .expect("the binding never waits on its own hold")
    }

    fn text(&self, sql: &str) -> Option<String> {
        self.roots
            .rows
            .query_row(sql, [], |row| row.get(0))
            .expect("the test reads a row")
    }

    fn contexts_of(&self, run_id: RunId) -> i64 {
        self.roots.count(&format!(
            "SELECT count(*) FROM run_execution_contexts WHERE run_id = '{run_id}'"
        ))
    }
}

fn session_id() -> SessionId {
    SessionId::new(SESSION_ID).expect("the id is a UUID")
}

fn run_context(run_id: RunId, workspace_id: Option<WorkspaceId>) -> RunSetupContext {
    RunSetupContext {
        run_id,
        session_id: session_id(),
        queue_item: None,
        workspace_id,
        execution_posture: serde_json::from_value(json!({
            "mode": "yolo",
            "credentialPolicyRef": "curated-credentials",
            "writableRoots": [],
        }))
        .expect("the posture reads"),
    }
}

// The unresolved refusal the gate answers, checked for its code, and its cause's code.
fn unresolved_cause_code(error: RunSetupGateError) -> Option<String> {
    let RunSetupGateError::Refused(DomainError { code, detail, .. }) = error else {
        panic!("the run is refused, not failed: {error}");
    };
    assert_eq!(code, RefusalCode::WorkspaceExecutionRootUnresolved);
    detail
        .and_then(|detail| detail.get("causeCode").cloned())
        .and_then(|cause_code| cause_code.as_str().map(str::to_owned))
}

#[tokio::test]
async fn a_first_run_in_a_preparing_worktree_workspace_makes_its_tree_from_the_title() {
    // Catches the tail left off the run's prepare: the tree would be refused a name or named
    // `run-<id>`, not from the session's title.
    let fixture = GateFixture::new().await;
    fixture
        .roots
        .rows
        .execute(
            "UPDATE sessions SET name = 'Fix the login redirect' WHERE id = ?1",
            [SESSION_ID],
        )
        .expect("the session is named");
    let workspace_id = fixture.bind(ExecutionMode::ProvisionedWorktree).await;
    let run_id = test_run_id();

    fixture
        .assert_ready(&run_context(run_id, None))
        .await
        .expect("the run is bound");

    assert_eq!(
        fixture.text("SELECT branch_name FROM worktrees").as_deref(),
        Some("fix-the-login-redirect")
    );
    assert_eq!(
        fixture.roots.workspace(workspace_id).state,
        "ready",
        "the first root completed the workspace"
    );
    assert_eq!(
        fixture.roots.count(&format!(
            "SELECT count(*) FROM run_execution_contexts AS run \
             JOIN worktrees AS tree ON tree.id = run.worktree_id \
             WHERE run.run_id = '{run_id}' AND run.workspace_id = '{workspace_id}' \
             AND run.execution_root = tree.fs_root AND run.released_at IS NULL"
        )),
        1,
        "the run is rooted in the tree it made"
    );

    fixture
        .gate
        .on_run_terminal(
            &RunTerminalContext {
                run_id,
                session_id: session_id(),
                terminal_state: RunState::Completed,
                run_version: 1,
            },
            None,
        )
        .await
        .expect("the run's end releases its root");
    assert_eq!(
        fixture.roots.count(&format!(
            "SELECT count(*) FROM run_execution_contexts \
             WHERE run_id = '{run_id}' AND released_at IS NOT NULL"
        )),
        1
    );
}

#[tokio::test]
async fn a_run_whose_folder_holds_another_repository_is_refused_writing_no_context() {
    // Catches the common-folder compare dropped: the run would be bound in another repository's
    // checkout while the mount itself reads healthy.
    let fixture = GateFixture::new().await;
    let scratch = fixture
        .roots
        .repository
        .parent()
        .expect("the repository sits in the scratch folder")
        .to_path_buf();
    let other = make_test_repository(&fixture.roots.git, &scratch, "other").await;
    let other_root = other.to_string_lossy().into_owned();
    fixture
        .roots
        .rows
        .execute_batch(&format!(
            "INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, fs_root, \
             state, metadata, created_at, updated_at) VALUES ('{OTHER_WORKSPACE_ID}', \
             '{SESSION_ID}', '{MOUNT_ID}', 'boundRoot', '{other_root}', 'ready', \
             json_object('boundRoot', '{other_root}', 'checkoutRoot', '{other_root}'), \
             '{PARENT_ROWS_AT}', '{PARENT_ROWS_AT}');
             INSERT INTO branch_contexts (id, workspace_id, base_branch, head_branch, \
             created_at, updated_at) VALUES ('branch-context', '{OTHER_WORKSPACE_ID}', 'main', \
             'main', '{PARENT_ROWS_AT}', '{PARENT_ROWS_AT}')"
        ))
        .expect("the workspace on the other repository is stored");
    let run_id = test_run_id();

    let refused = fixture
        .assert_ready(&run_context(run_id, None))
        .await
        .expect_err("the run's folder is another repository's");

    assert_eq!(
        unresolved_cause_code(refused).as_deref(),
        Some("repoMount.rootResolutionFailed")
    );
    assert_eq!(fixture.contexts_of(run_id), 0);
}

#[tokio::test]
async fn no_context_is_written_into_a_tree_whose_removal_commits_after_the_binding_read_it() {
    // Catches the retired-and-uncleaned clause dropped from the context write: the run would be
    // bound into a tree the sweep is about to delete.
    let fixture = GateFixture::new().await;
    fixture.bind(ExecutionMode::ProvisionedWorktree).await;
    fixture
        .assert_ready(&run_context(test_run_id(), None))
        .await
        .expect("the first run makes the tree");
    let run_id = test_run_id();
    let paused = fixture.gate.write_pause.arm();

    let context = run_context(run_id, None);
    let binding = fixture.assert_ready(&context);
    let retire = async {
        paused.reached.await.expect("the binding read its root");
        fixture
            .roots
            .rows
            .execute("UPDATE worktrees SET state = 'retired'", [])
            .expect("the tree's removal commits");
        paused
            .release
            .send(())
            .expect("the binding waits at its pause");
    };
    let (refused, ()) = tokio::join!(binding, retire);

    assert_eq!(
        unresolved_cause_code(refused.expect_err("the tree's removal refuses the run")).as_deref(),
        Some("workspace.rootUnavailable")
    );
    assert_eq!(fixture.contexts_of(run_id), 0);
}

#[tokio::test]
async fn a_send_naming_a_workspace_the_session_does_not_hold_is_refused_unresolved() {
    // Catches a named workspace that is absent passing as a session with no repository.
    let fixture = GateFixture::new().await;
    fixture.bind(ExecutionMode::BoundRoot).await;
    let run_id = test_run_id();

    let refused = fixture
        .assert_ready(&run_context(
            run_id,
            Some(WorkspaceId::new(OTHER_WORKSPACE_ID).expect("the id is a UUID")),
        ))
        .await
        .expect_err("the named workspace is not the session's");

    assert_eq!(unresolved_cause_code(refused), None);
    assert_eq!(fixture.moves.sweeps.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.contexts_of(run_id), 0);
}

#[tokio::test]
async fn a_preparing_workspace_with_a_pending_move_binds_under_the_gates_one_hold() {
    // Catches a held call that takes the preparation lock again: the pending move's held form or
    // the run's prepare would wait on the gate's own hold, past the bound.
    let fixture = GateFixture::new().await;
    let workspace_id = fixture.bind(ExecutionMode::BoundRoot).await;
    let person_tree = fixture.roots.add_tree("person-made").await;
    *lock(&fixture.moves.pending) = Some(person_tree.clone());
    let run_id = test_run_id();

    fixture
        .assert_ready(&run_context(run_id, None))
        .await
        .expect("the pending move and the binding land under one hold");

    assert_eq!(fixture.roots.workspace(workspace_id).state, "ready");
    assert_eq!(
        fixture
            .text(&format!(
                "SELECT execution_root FROM run_execution_contexts WHERE run_id = '{run_id}'"
            ))
            .as_deref(),
        Some(person_tree.to_string_lossy().as_ref())
    );
}
