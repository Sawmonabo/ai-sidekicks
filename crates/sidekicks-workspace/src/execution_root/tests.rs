use std::sync::Arc;
use std::time::Duration;

use rusqlite::params;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::repo::mount::{ExecutionMode, WorkspaceId};
use sidekicks_contracts::worktree::lifecycle::WorktreeId;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_platforms::Spawner;
use sidekicks_store::database::writer::test_file::test_run_id;

use super::ExecutionRootError;
use super::test_fixture::{ExecutionRootFixture, MOUNT_ID, SESSION_ID};
use crate::git::process::{GitLimits, GitRunner};
use crate::git::worktree::schema::schema_parts;
use crate::test_rows::PARENT_ROWS_AT;

const WORKSPACE_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e82";
const DAEMON_TREE_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e83";

// Far past any git call these tests make, so only a preparation waiting on itself reaches it.
const DEADLOCK_BOUND: Duration = Duration::from_secs(60);

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
    let fixture = ExecutionRootFixture::with(schema_parts(), no_git).await;
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
            .move_to_folder_held(&hold, &person_tree, None)
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
