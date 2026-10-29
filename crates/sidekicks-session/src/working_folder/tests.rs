use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use notify::NullWatcher;
use rusqlite::params;
use serde_json::json;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::repo::mount::{RepoMountId, WorkspaceId};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::directory::{
    SessionWorkingFolderDisposition, SessionWorkingFolderUpdateRequest,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::worktree::lifecycle::WorktreeId;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::test_run_id;
use sidekicks_store::events::session::append_lock::SESSION_APPEND_LOCK;
use sidekicks_workspace::event_emitter::WorkspaceEventEmitter;
use sidekicks_workspace::execution_root::test_fixture::{
    ExecutionRootFixture, MOUNT_ID, SESSION_ID,
};
use sidekicks_workspace::git::process::test_git_runner;
use sidekicks_workspace::git::worktree::event_emitter::WorktreeEventEmitter;
use sidekicks_workspace::git::worktree::removal::{WorktreeSessionSweep, WorktreeSweep};
use sidekicks_workspace::project::list_feed::ProjectListFeed;
use sidekicks_workspace::project::records::ProjectRecords;
use sidekicks_workspace::repo::mount::reattach::{
    RepoMountReattachService, RepoMountReattachServiceDeps,
};
use sidekicks_workspace::repo::root_resolver::RepoRootResolver;
use sidekicks_workspace::run_setup_gates::execution_root::{
    ExecutionRootSetupGate, ExecutionRootSetupGateDeps, SessionFolderMoves,
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
        roots
            .rows
            .execute(
                "UPDATE repo_mounts SET metadata = json_set(metadata, '$.commonDir', ?1) \
                 WHERE id = ?2",
                params![roots.repository.join(".git").to_string_lossy(), MOUNT_ID],
            )
            .expect("the mount records its anchor");
        let folders = Arc::new(SessionWorkingFolders::new(SessionWorkingFoldersDeps {
            reads: Arc::clone(&roots.reads),
            writer: Arc::clone(&roots.log.writer),
            execution_roots: Arc::clone(&roots.service),
            worktree_events: Arc::new(WorktreeEventEmitter::new(Arc::clone(&roots.log.service))),
        }));
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
                agents: Arc::new(SessionLiveRunFolders::new(Arc::clone(&roots.reads))),
            },
        ));
        let records = Arc::new(ProjectRecords::new(
            Arc::clone(&roots.reads),
            Arc::new(ProjectSessionActivityReader::new(&NoPlanHolds)),
        ));
        let gate = ExecutionRootSetupGate::new(ExecutionRootSetupGateDeps {
            writer: Arc::clone(&roots.log.writer),
            reads: Arc::clone(&roots.reads),
            git: test_git_runner(),
            workspaces: Arc::clone(&roots.workspaces),
            execution_roots: Arc::clone(&roots.service),
            reattach,
            moves: Arc::clone(&folders) as _,
            checkout_lock: Arc::new(KeyedLock::new()),
            list_feed: Arc::new(ProjectListFeed::new(records, &roots.log.followers)),
        });
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
                queue_item: None,
                workspace_id: None,
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

// Dies to the take answering a pending move whose clear removed nothing: both appliers that read
// the move then make it, one move event each.
#[tokio::test]
async fn two_appliers_of_one_pending_move_make_it_once() {
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
    first_take
        .release
        .send(())
        .expect("the first applier waits");

    first
        .await
        .expect("the first applier ends")
        .expect("the move lands");
    second
        .await
        .expect("the second applier ends")
        .expect("the second applier answers");
    assert_eq!(
        fixture.roots.workspace(workspace_id).bound_root,
        Some(path_text(&feature))
    );
    assert_eq!(fixture.prepared_count(), 2, "the move was made once");
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
