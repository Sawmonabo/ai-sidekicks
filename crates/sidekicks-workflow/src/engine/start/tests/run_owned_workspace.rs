//! A start naming a project from a chat: the run works in a workspace of its own on that project's
//! folder, which the chat's reads leave out, which its ending archives and its delete removes.

use std::path::{Path, PathBuf};

use rusqlite::params;
use serde_json::json;
use sidekicks_contracts::daemon::config::WorkflowChainAskAfterRuns;
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::repo::mount::{ExecutionMode, WorkspaceState};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::run::status::WorkflowRunStatus;
use sidekicks_contracts::workflow::run::trigger::WorkflowRunChainPlace;
use sidekicks_workspace::working_folder::read_working_folder;

use super::{
    Fixture, REPOSITORY_MOUNT_ID, ROWS_AT, TestSession, body, git_node, joins_root, runs_folders,
    session_folder, session_id, start, started,
};
use crate::engine::start::{WorkflowStartArrival, WorkflowStartOutcome};
use crate::runs::deletion::workflow_run_deletion_statements;
use crate::runs::record::end_run_statements;
use crate::test_rows::TEST_SESSION_ID;

fn project_id() -> ProjectId {
    ProjectId::new(REPOSITORY_MOUNT_ID).expect("the project's id")
}

/// A chat working in a folder of its own on the project's mount starts a run naming that project:
/// the run works at the project's root in a workspace of its own beside the chat's, records one
/// context row on it, passes the repository rule and takes the project as its scope's, while the
/// chat's working folder still reads its own; the run's ending archives that workspace and the
/// run's delete removes it with its branch context. Mutations: the working-folder read without its
/// run-owned filter (it reads the project's root); the bind's own-workspace guard or the live
/// index left unfiltered (the bind is refused); the repository rule still refusing a named
/// project; the archive left out of the ending; the workspace or its branch context left out of
/// the delete (a row stays, or the foreign key refuses the delete).
#[tokio::test]
async fn a_chat_start_naming_a_project_works_in_a_workspace_of_the_runs_own() {
    let fixture = Fixture::new(
        &body(None, &json!([git_node()])),
        TestSession::WithoutFolder,
        None,
    )
    .await;
    let chat_folder = session_folder(&fixture.roots.database);
    fixture
        .rows
        .execute(
            "INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, fs_root, \
             state, created_at, updated_at) VALUES ('chat-workspace', ?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![
                TEST_SESSION_ID,
                REPOSITORY_MOUNT_ID,
                <&'static str>::from(ExecutionMode::BoundRoot),
                chat_folder.to_string_lossy(),
                <&'static str>::from(WorkspaceState::Ready),
                ROWS_AT
            ],
        )
        .expect("the chat's own workspace is stored");
    let mut request = start(
        WorkflowStartArrival::Person,
        WorkflowRunChainPlace::Starts {},
        Vec::new(),
    );
    request.project_id = Some(project_id());

    let run = started(fixture.starter.start(request).await);

    let run_id = run.scope.run_id;
    let run_workspace: String = fixture
        .rows
        .query_row(
            "SELECT id FROM workspaces WHERE workflow_run_id = ?1",
            [run_id.text().as_str()],
            |row| row.get(0),
        )
        .expect("the run owns a workspace");
    let (context_workspace, root, _, released_at) = fixture
        .execution_context(run_id)
        .expect("the run records its execution context");
    assert_eq!(context_workspace, run_workspace);
    assert_eq!(Path::new(&root), fixture.roots.repository);
    assert_eq!(released_at, None);
    assert_eq!(run.scope.working_folder, fixture.roots.repository);
    assert_eq!(run.scope.project, Some(project_id()));
    let chat = read_working_folder(&fixture.rows, &session_id()).expect("the chat's folder reads");
    assert_eq!(chat.working_folder, Some(chat_folder));
    assert_eq!(owned_rows(&fixture, &run_workspace), (1, 1));

    fixture
        .roots
        .log
        .writer
        .write(Vec::from(end_run_statements(
            run_id,
            WorkflowRunStatus::Succeeded,
            &WireInstant::now(),
            None,
        )))
        .await
        .expect("the run ends");
    let state: String = fixture
        .rows
        .query_row(
            "SELECT state FROM workspaces WHERE id = ?1",
            [&run_workspace],
            |row| row.get(0),
        )
        .expect("the run's workspace is read");
    assert_eq!(state, <&'static str>::from(WorkspaceState::Archived));

    fixture
        .roots
        .log
        .writer
        .write(workflow_run_deletion_statements(&[run_id]))
        .await
        .expect("the run is deleted");
    assert_eq!(owned_rows(&fixture, &run_workspace), (0, 0));
    assert_eq!(
        fixture.count("SELECT COUNT(*) FROM workspaces WHERE id = 'chat-workspace'"),
        1
    );
}

/// A chat start naming a project that is held on its chain leaves no workspace behind: the
/// binding's workspace and its branch context are deleted, since no run owns them. Mutation: the
/// held start's workspace left in place.
#[tokio::test]
async fn a_held_start_naming_a_project_leaves_no_workspace() {
    let fixture = Fixture::new(
        &body(None, &json!([])),
        TestSession::WithoutFolder,
        WorkflowChainAskAfterRuns::new(25),
    )
    .await;
    fixture.store_chain_root(25);
    let mut request = start(WorkflowStartArrival::Person, joins_root(), Vec::new());
    request.project_id = Some(project_id());

    let outcome = fixture.starter.start(request).await;

    assert!(matches!(
        outcome,
        Ok(WorkflowStartOutcome::HeldOnChain { .. })
    ));
    assert_eq!(fixture.count("SELECT COUNT(*) FROM workspaces"), 0);
    assert_eq!(fixture.count("SELECT COUNT(*) FROM branch_contexts"), 0);
    assert_eq!(runs_folders(&fixture.data_folder()), Vec::<PathBuf>::new());
}

// The rows of the workspace `workspace_id`: itself, and its branch contexts.
fn owned_rows(fixture: &Fixture, workspace_id: &str) -> (i64, i64) {
    (
        fixture.count(&format!(
            "SELECT COUNT(*) FROM workspaces WHERE id = '{workspace_id}'"
        )),
        fixture.count(&format!(
            "SELECT COUNT(*) FROM branch_contexts WHERE workspace_id = '{workspace_id}'"
        )),
    )
}
