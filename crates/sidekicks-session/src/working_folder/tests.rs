use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use notify::NullWatcher;
use rusqlite::params;
use serde_json::json;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::repo::folders::RepoMountRequest;
use sidekicks_contracts::repo::mount::{RepoMountId, WorkspaceId};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::directory::{
    SessionWorkingFolderDisposition, SessionWorkingFolderUpdateRequest,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::worktree::lifecycle::{RunningHolder, WorktreeId};
use sidekicks_ipc::registry::HandlerError;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::test_run_id;
use sidekicks_store::events::session::append_lock::SESSION_APPEND_LOCK;
use sidekicks_workspace::event_emitter::WorkspaceEventEmitter;
use sidekicks_workspace::execution_root::test_fixture::{
    ExecutionRootFixture, MOUNT_ID, SESSION_ID,
};
use sidekicks_workspace::git::process::test_git_runner;
use sidekicks_workspace::git::turn_snapshot::capture::GitFloorReports;
use sidekicks_workspace::git::turn_snapshot::repack::CapturePacking;
use sidekicks_workspace::git::worktree::creation::{LiveRunFolder, LiveRunFolderReader};
use sidekicks_workspace::git::worktree::event_emitter::WorktreeEventEmitter;
use sidekicks_workspace::git::worktree::removal::{WorktreeSessionSweep, WorktreeSweep};
use sidekicks_workspace::repo::mount::reattach::{
    RepoMountReattachService, RepoMountReattachServiceDeps,
};
use sidekicks_workspace::repo::root_resolver::RepoRootResolver;
use sidekicks_workspace::run_setup_gates::execution_root::context::{
    SessionRunBinder, context_statement,
};
use sidekicks_workspace::run_setup_gates::execution_root::{
    ExecutionRootSetupGate, SessionFolderMoves,
};
use sidekicks_workspace::run_setup_gates::{RunSetupContext, RunSetupGate, RunTerminalContext};

use super::{SessionWorkingFolders, SessionWorkingFoldersDeps};
use crate::directory::run_activity::ProjectSessionActivityReader;
use crate::plan_holds::NoPlanHolds;
use crate::questions::schema::schema_parts;
use crate::run::folders::SessionLiveRunFolders;

const OTHER_SESSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4eb0";

// Far past any git call these tests make, so only an append waiting on the hold the test holds
// reaches it.
const DEADLOCK_BOUND: Duration = Duration::from_secs(60);

// Long enough for a call the test's preparation hold does not hold to finish, so one still running
// then waits on that hold.
const REACH_BOUND: Duration = Duration::from_secs(1);

// A workspace the session does not work in.
const OTHER_WORKSPACE_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4eb1";

// A workflow run of the session, which the run engine's runs table never holds.
const WORKFLOW_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4eb2";

/// The working folders and the run setup gate over the execution roots' fixture, its database
/// holding the runs table and its mount recording the repository's common folder.
struct Fixture {
    roots: ExecutionRootFixture,
    folders: Arc<SessionWorkingFolders<NullWatcher>>,
    gate: ExecutionRootSetupGate<NullWatcher>,
}

impl Fixture {
    async fn new() -> Self {
        let roots = ExecutionRootFixture::with(schema_parts(), test_git_runner()).await;
        let folders = Arc::new(SessionWorkingFolders::new(SessionWorkingFoldersDeps {
            reads: Arc::clone(&roots.reads),
            writer: Arc::clone(&roots.log.writer),
            execution_roots: Arc::clone(&roots.service),
            worktree_events: Arc::new(WorktreeEventEmitter::new(Arc::clone(&roots.log.service))),
        }));
        let gate = roots.setup_gate(
            Arc::clone(&folders) as _,
            Arc::new(ProjectSessionActivityReader::new(&NoPlanHolds)),
        );
        Self {
            roots,
            folders,
            gate,
        }
    }

    /// A `boundRoot` workspace prepared `ready` at the repository.
    async fn ready_at_repository(&self) -> WorkspaceId {
        let workspace_id = self.roots.bind().await;
        self.roots
            .prepare(workspace_id, None)
            .await
            .expect("the bound folder is prepared");
        workspace_id
    }

    /// A run of the session, `running`, bound to its folder by the gate.
    async fn bind_running_run(&self) -> RunId {
        let run_id = test_run_id();
        self.roots
            .rows
            .execute(
                "INSERT INTO runs (run_id, session_id, state, run_version) \
                 VALUES (?1, ?2, 'running', 1)",
                params![run_id.text().as_str(), SESSION_ID],
            )
            .expect("the run is stored");
        tokio::time::timeout(
            DEADLOCK_BOUND,
            self.gate.assert_run_ready(&RunSetupContext {
                run_id,
                session_id: session_id(),
                opening_words: None,
                workspace_id: None,
                parent_run: None,
                execution_posture: serde_json::from_value(json!({
                    "mode": "yolo",
                    "credentialPolicyRef": "curated-credentials",
                    "writableRoots": [],
                }))
                .expect("the posture reads"),
            }),
        )
        .await
        .expect("the binding never waits on its own hold")
        .expect("the run binds");
        run_id
    }

    /// The workflow run [`WORKFLOW_RUN_ID`] of the session bound by the gate, its context written
    /// as the start's write does.
    async fn bind_workflow_run(&self) {
        let binding = self
            .gate
            .bind_session_run(session_id(), WORKFLOW_RUN_ID, "Nightly")
            .await
            .expect("the workflow run binds");
        self.roots
            .log
            .writer
            .write(vec![context_statement(&binding, &WireInstant::now())])
            .await
            .expect("the workflow run's context is written");
    }

    /// Ends the run `completed` and runs the gate's end under the test's own hold of the session's
    /// append lock, as the run engine ends a run.
    async fn end_run_under_held_session(&self, run_id: RunId) {
        self.roots
            .rows
            .execute(
                "UPDATE runs SET state = 'completed' WHERE run_id = ?1",
                [run_id.text().as_str()],
            )
            .expect("the run ends");
        let hold = SESSION_APPEND_LOCK.acquire(session_id()).await;
        tokio::time::timeout(
            DEADLOCK_BOUND,
            self.gate.on_run_terminal(
                &RunTerminalContext {
                    run_id,
                    session_id: session_id(),
                    terminal_state: RunState::Completed,
                    run_version: 1,
                },
                Some(&hold),
            ),
        )
        .await
        .expect("the run's end never waits on the session hold its caller holds")
        .expect("the run's end lands");
    }

    async fn set(&self, folder: &Path) -> SessionWorkingFolderDisposition {
        self.folders
            .set(&SessionWorkingFolderUpdateRequest {
                session_id: session_id(),
                path: wire_path(folder),
            })
            .await
            .expect("the move is taken")
            .disposition
    }

    /// Holds `folder` as the session's pending move, asked for `workspace_id`.
    fn hold_move_to(&self, folder: &Path, workspace_id: WorkspaceId) {
        self.roots
            .rows
            .execute(
                "UPDATE sessions \
                 SET pending_working_folder = ?1, pending_working_folder_workspace_id = ?2 \
                 WHERE id = ?3",
                params![
                    folder.to_string_lossy(),
                    workspace_id.text().as_str(),
                    SESSION_ID
                ],
            )
            .expect("the move is held");
    }

    fn prepared_count(&self) -> i64 {
        self.roots
            .count("SELECT count(*) FROM session_events WHERE type = 'workspace.prepared'")
    }

    fn pending(&self, session_id: &str) -> Option<String> {
        self.text(&format!(
            "SELECT pending_working_folder FROM sessions WHERE id = '{session_id}'"
        ))
    }

    fn text(&self, sql: &str) -> Option<String> {
        self.roots
            .rows
            .query_row(sql, [], |row| row.get(0))
            .expect("the test reads a row")
    }

    // Each `session.sweptToCheckout` the session's log holds, by whether it cleared a pending move.
    fn sweeps_of(&self, session_id: &str) -> Vec<bool> {
        let mut statement = self
            .roots
            .rows
            .prepare(
                "SELECT json_extract(payload, '$.pendingMoveCleared') IS NOT NULL \
                 FROM session_events WHERE session_id = ?1 AND type = 'session.sweptToCheckout' \
                 ORDER BY sequence",
            )
            .expect("the sweeps are read");
        statement
            .query_map([session_id], |row| row.get(0))
            .expect("the sweeps are read")
            .collect::<rusqlite::Result<Vec<bool>>>()
            .expect("the sweeps are read")
    }
}

fn session_id() -> SessionId {
    SessionId::new(SESSION_ID).expect("the id is a UUID")
}

fn wire_path(folder: &Path) -> FilesystemPath {
    FilesystemPath::new(folder.to_string_lossy().into_owned()).expect("a test folder is a path")
}

fn path_text(folder: &Path) -> String {
    folder.to_string_lossy().into_owned()
}

#[tokio::test]
async fn a_move_while_a_run_is_live_waits_for_the_runs_end() {
    // Catches a move made at once while a run is live: the workspace would leave the repository
    // while the run still works there.
    let fixture = Fixture::new().await;
    let workspace_id = fixture.ready_at_repository().await;
    let feature = fixture.roots.add_tree("feature").await;
    let other = fixture.roots.add_tree("other").await;
    let run_id = fixture.bind_running_run().await;
    let repository = Some(path_text(&fixture.roots.repository));

    assert_eq!(
        fixture.set(&feature).await,
        SessionWorkingFolderDisposition::Pending
    );
    assert_eq!(fixture.pending(SESSION_ID), Some(path_text(&feature)));
    assert_eq!(
        fixture.roots.workspace(workspace_id).bound_root,
        repository,
        "the live run's folder stays put"
    );

    assert_eq!(
        fixture.set(&other).await,
        SessionWorkingFolderDisposition::Pending
    );
    assert_eq!(
        fixture.pending(SESSION_ID),
        Some(path_text(&other)),
        "a later request replaces the held move"
    );

    assert_eq!(
        fixture.set(&fixture.roots.repository).await,
        SessionWorkingFolderDisposition::Applied
    );
    assert_eq!(
        fixture.pending(SESSION_ID),
        None,
        "the current folder clears the held move"
    );

    assert_eq!(
        fixture.set(&feature).await,
        SessionWorkingFolderDisposition::Pending
    );
    fixture.end_run_under_held_session(run_id).await;
    let moved = fixture.roots.workspace(workspace_id);
    assert_eq!(moved.state, "ready");
    assert_eq!(moved.bound_root, Some(path_text(&feature)));
    assert_eq!(fixture.pending(SESSION_ID), None);
}

/// A live workflow run holds no move: the session moves at once, and the run's context keeps the
/// root it recorded. Mutation: the live-run read counting a workflow run's context, which holds the
/// move pending.
#[tokio::test]
async fn a_live_workflow_run_never_holds_its_sessions_move() {
    let fixture = Fixture::new().await;
    let workspace_id = fixture.ready_at_repository().await;
    let feature = fixture.roots.add_tree("feature").await;
    fixture.bind_workflow_run().await;

    assert_eq!(
        fixture.set(&feature).await,
        SessionWorkingFolderDisposition::Applied
    );
    assert_eq!(
        fixture.roots.workspace(workspace_id).bound_root,
        Some(path_text(&feature))
    );
    assert_eq!(
        fixture.text(&format!(
            "SELECT execution_root FROM run_execution_contexts WHERE run_id = '{WORKFLOW_RUN_ID}' \
             AND released_at IS NULL"
        )),
        Some(path_text(&fixture.roots.repository))
    );
}

#[tokio::test]
async fn a_pending_move_applied_under_the_callers_session_hold_never_waits_on_it() {
    // Catches a plain append inside the held move: a ready workspace's move appends
    // `workspace.preparing` and `workspace.prepared`, and either would wait on the hold forever.
    let fixture = Fixture::new().await;
    let workspace_id = fixture.ready_at_repository().await;
    let feature = fixture.roots.add_tree("feature").await;
    fixture.hold_move_to(&feature, workspace_id);

    let hold = SESSION_APPEND_LOCK.acquire(session_id()).await;
    tokio::time::timeout(
        DEADLOCK_BOUND,
        fixture.folders.apply_pending(&session_id(), Some(&hold)),
    )
    .await
    .expect("the move never waits on the session hold its caller holds")
    .expect("the move lands");
    drop(hold);

    assert_eq!(
        fixture.roots.workspace(workspace_id).bound_root,
        Some(path_text(&feature))
    );
    assert_eq!(
        fixture.prepared_count(),
        2,
        "the first preparation and the move each end prepared"
    );
}

// Dies to the live-run read made before the preparation hold: a run bound by its gate while the
// move waited for that hold would have its folder moved under it.
#[tokio::test]
async fn a_run_bound_while_the_move_waits_for_the_hold_holds_the_move() {
    let fixture = Fixture::new().await;
    let workspace_id = fixture.ready_at_repository().await;
    let feature = fixture.roots.add_tree("feature").await;
    let gate_hold = fixture.roots.service.hold_preparation(workspace_id).await;
    let mut set = Box::pin(fixture.set(&feature));
    assert!(
        tokio::time::timeout(REACH_BOUND, &mut set).await.is_err(),
        "the move waits for the gate's hold"
    );
    fixture
        .roots
        .rows
        .execute(
            "INSERT INTO runs (run_id, session_id, state, run_version) \
             VALUES (?1, ?2, 'running', 1)",
            params![test_run_id().text().as_str(), SESSION_ID],
        )
        .expect("the gate's run is stored");
    drop(gate_hold);

    assert_eq!(set.await, SessionWorkingFolderDisposition::Pending);
    assert_eq!(fixture.pending(SESSION_ID), Some(path_text(&feature)));
    assert_eq!(
        fixture.roots.workspace(workspace_id).bound_root,
        Some(path_text(&fixture.roots.repository))
    );
}

// Dies to the pending move's stored workspace left uncompared: a move asked for one workspace is
// then made under the hold of another, or after the session moved on to another workspace.
#[rstest::rstest]
#[case::held_for_another(false)]
#[case::asked_for_another(true)]
#[tokio::test]
async fn a_pending_move_for_another_workspace_than_its_own_is_dropped(
    #[case] is_asked_for_another: bool,
) {
    let fixture = Fixture::new().await;
    let workspace_id = fixture.ready_at_repository().await;
    let feature = fixture.roots.add_tree("feature").await;
    let other = WorkspaceId::new(OTHER_WORKSPACE_ID).expect("a workspace id");
    let (asked, held) = if is_asked_for_another {
        (other, workspace_id)
    } else {
        (workspace_id, other)
    };
    fixture.hold_move_to(&feature, asked);
    let hold = fixture.roots.service.hold_preparation(held).await;

    fixture
        .folders
        .apply_pending_held(&session_id(), &hold)
        .await
        .expect("the stale move is dropped");

    assert_eq!(fixture.pending(SESSION_ID), None);
    assert_eq!(
        fixture.roots.workspace(workspace_id).bound_root,
        Some(path_text(&fixture.roots.repository))
    );
    assert_eq!(fixture.prepared_count(), 1, "nothing was moved");
}

// Dies to the pending move taken before its workspace's hold, or to the live run read outside
// it: a run bound by its gate while the apply waited for that hold would have its folder moved
// under it.
#[tokio::test]
async fn a_run_bound_while_a_pending_move_waits_for_the_hold_keeps_it_pending() {
    let fixture = Fixture::new().await;
    let workspace_id = fixture.ready_at_repository().await;
    let feature = fixture.roots.add_tree("feature").await;
    fixture.hold_move_to(&feature, workspace_id);
    let gate_hold = fixture.roots.service.hold_preparation(workspace_id).await;
    let session = session_id();
    let mut apply = fixture.folders.apply_pending(&session, None);
    assert!(
        tokio::time::timeout(REACH_BOUND, &mut apply).await.is_err(),
        "the apply waits for the gate's hold"
    );
    fixture
        .roots
        .rows
        .execute(
            "INSERT INTO runs (run_id, session_id, state, run_version) \
             VALUES (?1, ?2, 'running', 1)",
            params![test_run_id().text().as_str(), SESSION_ID],
        )
        .expect("the gate's run is stored");
    drop(gate_hold);

    apply.await.expect("the apply ends");
    assert_eq!(fixture.pending(SESSION_ID), Some(path_text(&feature)));
    assert_eq!(
        fixture.roots.workspace(workspace_id).bound_root,
        Some(path_text(&fixture.roots.repository))
    );
}

// Dies to the take answering a pending move whose clear removed nothing: the second applier, which
// read the move before the first took it, would try it again and surface its failure twice.
#[tokio::test]
async fn two_appliers_of_one_pending_move_try_it_once() {
    let fixture = Fixture::new().await;
    let workspace_id = fixture.ready_at_repository().await;
    let feature = fixture.roots.add_tree("feature").await;
    fixture.hold_move_to(&feature, workspace_id);
    let first_take = fixture.folders.pending_take_pause.arm();
    let apply = |folders: Arc<SessionWorkingFolders<NullWatcher>>| {
        tokio::spawn(async move {
            folders
                .apply_pending(&session_id(), None)
                .await
                .map_err(|error| error.to_string())
        })
    };

    let first = apply(Arc::clone(&fixture.folders));
    first_take
        .reached
        .await
        .expect("the first applier takes the move under the hold");
    let mut second = apply(Arc::clone(&fixture.folders));
    assert!(
        tokio::time::timeout(REACH_BOUND, &mut second)
            .await
            .is_err(),
        "the second applier reads the move and waits for the hold"
    );
    std::fs::remove_dir_all(&feature).expect("the tree's folder is removed");
    first_take
        .release
        .send(())
        .expect("the first applier waits");

    first
        .await
        .expect("the first applier ends")
        .expect_err("the move to a removed folder fails");
    second
        .await
        .expect("the second applier ends")
        .expect("the second applier finds the move taken");
    assert_eq!(fixture.pending(SESSION_ID), None);
    assert_eq!(
        fixture.roots.workspace(workspace_id).bound_root,
        Some(path_text(&fixture.roots.repository))
    );
    assert_eq!(fixture.prepared_count(), 1, "nothing was moved");
}

#[tokio::test]
async fn a_removed_trees_sweep_passes_over_a_bound_session_until_its_run_ends() {
    // Catches the bound-run skip dropped: the bound session would be moved under its live run at
    // the removal, and swept twice.
    let fixture = Fixture::new().await;
    let workspace_id = fixture.roots.bind().await;
    fixture
        .roots
        .prepare(workspace_id, Some("feature"))
        .await
        .expect("the tree is made");
    let (worktree_id, tree): (String, String) = fixture
        .roots
        .rows
        .query_row("SELECT id, fs_root FROM worktrees", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .expect("the tree is stored");
    let tree = PathBuf::from(tree);
    let run_id = fixture.bind_running_run().await;
    insert_session_row(&fixture.roots.rows, OTHER_SESSION_ID, None, None);
    fixture
        .roots
        .rows
        .execute(
            "UPDATE sessions \
             SET pending_working_folder = ?1, pending_working_folder_workspace_id = ?2 \
             WHERE id = ?3",
            params![tree.to_string_lossy(), OTHER_WORKSPACE_ID, OTHER_SESSION_ID],
        )
        .expect("the other session holds a move into the tree");
    fixture
        .roots
        .rows
        .execute(
            "UPDATE worktrees SET state = 'retired' WHERE id = ?1",
            [&worktree_id],
        )
        .expect("the tree is removed");

    fixture
        .folders
        .sweep_to_repo_root(&WorktreeSweep {
            repo_mount_id: RepoMountId::new(MOUNT_ID).expect("the id is a UUID"),
            worktree_id: WorktreeId::new(&worktree_id).expect("the id is a UUID"),
            folder: wire_path(&tree),
        })
        .await
        .expect("the sweep lands");
    assert_eq!(
        fixture.text(&format!(
            "SELECT fs_root FROM workspaces WHERE id = '{workspace_id}'"
        )),
        Some(path_text(&tree)),
        "the bound session keeps its folder"
    );
    assert_eq!(fixture.sweeps_of(SESSION_ID), Vec::<bool>::new());
    assert_eq!(fixture.sweeps_of(OTHER_SESSION_ID), vec![true]);
    assert_eq!(fixture.pending(OTHER_SESSION_ID), None);

    fixture.end_run_under_held_session(run_id).await;
    let swept = fixture.roots.workspace(workspace_id);
    assert_eq!(swept.state, "ready");
    assert_eq!(swept.execution_mode, "boundRoot");
    assert_eq!(
        fixture.text(&format!(
            "SELECT fs_root FROM workspaces WHERE id = '{workspace_id}'"
        )),
        Some(path_text(&fixture.roots.repository))
    );
    assert_eq!(fixture.sweeps_of(SESSION_ID), vec![false]);
    assert_eq!(
        fixture.sweeps_of(OTHER_SESSION_ID),
        vec![true],
        "a cleared move is swept once"
    );
}

/// A live workflow run is read as what it is: a carry from its checkout is refused naming it, and
/// a re-attach of its project is refused `repoMount.reattachConflict` naming it, never failing.
/// Mutation: every live context read as an agent run, whose agent the session's log never names
/// for a workflow run (both reads fail).
#[tokio::test]
async fn a_live_workflow_run_is_named_by_a_carrys_and_a_reattachs_refusal() {
    let fixture = Fixture::new().await;
    fixture.ready_at_repository().await;
    fixture.bind_workflow_run().await;
    let holders = Arc::new(SessionLiveRunFolders::new(Arc::clone(&fixture.roots.reads)));
    let workflow_run = RunningHolder::WorkflowRun {
        run_id: WorkflowRunId::new(WORKFLOW_RUN_ID).expect("the id is a UUID"),
    };

    let live_runs = holders
        .read_other_sessions_live_runs(&SessionId::new(OTHER_SESSION_ID).expect("a session id"))
        .await
        .expect("the live runs are read");
    assert_eq!(
        live_runs,
        vec![LiveRunFolder {
            session_id: session_id(),
            holder: workflow_run,
            folder: fixture.roots.repository.clone(),
        }]
    );

    let roots = &fixture.roots;
    let reattach = RepoMountReattachService::new(RepoMountReattachServiceDeps {
        writer: Arc::clone(&roots.log.writer),
        reads: Arc::clone(&roots.reads),
        workspaces: Arc::clone(&roots.workspaces),
        execution_roots: Arc::clone(&roots.service),
        events: Arc::new(WorkspaceEventEmitter::new(Arc::clone(&roots.log.service))),
        worktree_events: Arc::new(WorktreeEventEmitter::new(Arc::clone(&roots.log.service))),
        resolver: RepoRootResolver::new(test_git_runner()),
        holders,
        packing: Arc::new(CapturePacking::new(
            test_git_runner(),
            Arc::new(GitFloorReports::default()),
        )),
        data_folder: roots.scratch.path().join("data"),
        common_folder_columns: Vec::new(),
        attach_notice: Arc::default(),
    });
    roots.replace_repository().await;
    let refused = reattach
        .reattach(&RepoMountRequest {
            repo_mount_id: RepoMountId::new(MOUNT_ID).expect("the id is a UUID"),
        })
        .await
        .expect_err("the workflow run holds the project");
    let HandlerError::Refused(refusal) = HandlerError::from(refused) else {
        panic!("the re-attach is refused, not failed");
    };
    assert_eq!(refusal.code, RefusalCode::RepoMountReattachConflict);
    assert_eq!(
        refusal
            .detail
            .map(|detail| serde_json::Value::Object(*detail)),
        Some(json!({
            "runningSessionId": SESSION_ID,
            "runningHolder": { "kind": "workflowRun", "runId": WORKFLOW_RUN_ID },
        }))
    );
}

/// A removed tree's sweep passes over a workflow run's live context there: the session is swept
/// back to the repository at once, since only an agent run holds it. Mutation: the bound-run read
/// counting a workflow run's context, which keeps the session in the removed tree.
#[tokio::test]
async fn a_removed_trees_sweep_moves_a_session_whose_workflow_run_is_live_there() {
    let fixture = Fixture::new().await;
    let workspace_id = fixture.roots.bind().await;
    fixture
        .roots
        .prepare(workspace_id, Some("feature"))
        .await
        .expect("the tree is made");
    let (worktree_id, tree): (String, String) = fixture
        .roots
        .rows
        .query_row("SELECT id, fs_root FROM worktrees", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .expect("the tree is stored");
    fixture.bind_workflow_run().await;
    fixture
        .roots
        .rows
        .execute(
            "UPDATE worktrees SET state = 'retired' WHERE id = ?1",
            [&worktree_id],
        )
        .expect("the tree is removed");

    fixture
        .folders
        .sweep_to_repo_root(&WorktreeSweep {
            repo_mount_id: RepoMountId::new(MOUNT_ID).expect("the id is a UUID"),
            worktree_id: WorktreeId::new(&worktree_id).expect("the id is a UUID"),
            folder: wire_path(&PathBuf::from(tree)),
        })
        .await
        .expect("the sweep lands");

    assert_eq!(
        fixture.text(&format!(
            "SELECT fs_root FROM workspaces WHERE id = '{workspace_id}'"
        )),
        Some(path_text(&fixture.roots.repository))
    );
    assert_eq!(fixture.sweeps_of(SESSION_ID), vec![false]);
}
