use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::Connection;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::project::ProjectState;
use sidekicks_contracts::repo::mount::{ExecutionMode, RepoMountId, WorkspaceId, WorkspaceState};
use sidekicks_contracts::repo::workspace::{WorkspaceBindRequest, WorkspaceListRequest};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::real_path;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::events::log_service::test_fixture::open_log;

use super::preparation::CompletedRootPreparation;
use super::{
    WORKSPACE_SERVICE_STATEMENT_CAPACITY, WorkspaceService, WorkspaceServiceDeps,
    WorkspaceServiceError,
};
use crate::event_emitter::WorkspaceEventEmitter;
use crate::git::process::{GitCall, test_git_runner};
use crate::git::worktree::schema::schema_parts;
use crate::repo::root_resolver::RepoRootResolver;
use crate::test_rows::PARENT_ROWS_AT;

const SESSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e70";
const OTHER_SESSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e71";
const MOUNT_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e72";
const WORKSPACE_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e73";

/// The service over a test database whose sessions `SESSION_ID` and `OTHER_SESSION_ID` exist, and
/// a connection the test writes rows through.
async fn open_service(database: &TestDatabase) -> (Arc<WorkspaceService>, Connection) {
    let log = open_log(database, None).await;
    let service = WorkspaceService::new(WorkspaceServiceDeps {
        reads: Arc::new(DatabaseReadPool::new(
            database.path(),
            WORKSPACE_SERVICE_STATEMENT_CAPACITY,
        )),
        events: Arc::new(WorkspaceEventEmitter::new(log.service)),
        resolver: RepoRootResolver::new(test_git_runner()),
    });
    let rows = database.reader();
    insert_session_row(&rows, SESSION_ID, None, None);
    insert_session_row(&rows, OTHER_SESSION_ID, None, None);
    (Arc::new(service), rows)
}

/// A repository made in a fresh temporary folder, every link resolved, kept while the folder is.
async fn new_repository() -> (tempfile::TempDir, PathBuf) {
    let temporary = tempfile::tempdir().expect("the temporary folder is made");
    let root = real_path(temporary.path())
        .expect("the temporary folder resolves")
        .join("repository");
    test_git_runner()
        .run(None, GitCall::read([OsStr::new("init"), root.as_os_str()]))
        .await
        .expect("the repository is made");
    (temporary, root)
}

/// Stores a project and its attached mount `MOUNT_ID` at `root`.
fn insert_attached_mount(rows: &Connection, root: &Path) {
    let root = root.to_string_lossy();
    let active = <&'static str>::from(ProjectState::Active);
    rows.execute_batch(&format!(
        "INSERT INTO projects (id, name, slug, folder_path, state, setup, created_at, updated_at) \
         VALUES ('project', 'app', 'app', '{root}', '{active}', '{{}}', '{PARENT_ROWS_AT}', \
         '{PARENT_ROWS_AT}');
         INSERT INTO repo_mounts (id, machine_id, local_path, canonical_root, project_id, \
         attached_at, updated_at) VALUES ('{MOUNT_ID}', 'machine', '{root}', '{root}', \
         'project', '{PARENT_ROWS_AT}', '{PARENT_ROWS_AT}')"
    ))
    .expect("the attached mount is admitted");
}

fn bind_request(session_id: &str) -> WorkspaceBindRequest {
    WorkspaceBindRequest {
        session_id: SessionId::new(session_id).expect("the id is a UUID"),
        repo_mount_id: RepoMountId::new(MOUNT_ID).expect("the id is a UUID"),
        execution_mode: ExecutionMode::BoundRoot,
        directory: None,
    }
}

fn list_request() -> WorkspaceListRequest {
    WorkspaceListRequest {
        session_id: SessionId::new(SESSION_ID).expect("the id is a UUID"),
        repo_mount_id: None,
    }
}

fn count(rows: &Connection, sql: &str) -> i64 {
    rows.query_row(sql, [], |row| row.get(0))
        .expect("the test counts rows")
}

fn refusal_code(error: &WorkspaceServiceError) -> RefusalCode {
    match error {
        WorkspaceServiceError::Refused(refusal) => refusal.code,
        other @ (WorkspaceServiceError::Invariant(_)
        | WorkspaceServiceError::Read(_)
        | WorkspaceServiceError::Row(_)
        | WorkspaceServiceError::HealthProjection(_)
        | WorkspaceServiceError::Append(_)) => panic!("the call is refused, not {other:?}"),
    }
}

#[tokio::test]
async fn a_repeat_bind_answers_the_live_workspace_without_probing_or_writing() {
    // Catches the earlier-live-workspace read dropped: the repeat would then probe the mount's
    // gone folder and refuse.
    let database = TestDatabase::new(schema_parts());
    let (service, rows) = open_service(&database).await;
    let (temporary, root) = new_repository().await;
    insert_attached_mount(&rows, &root);

    let first = service
        .bind(&bind_request(SESSION_ID))
        .await
        .expect("the first bind lands");
    drop(temporary);
    let repeat = service
        .bind(&bind_request(SESSION_ID))
        .await
        .expect("the repeat answers the live workspace");

    assert_eq!(repeat, first);
    assert_eq!(repeat.state, WorkspaceState::Preparing);
    assert_eq!(count(&rows, "SELECT count(*) FROM workspaces"), 1);
    assert_eq!(
        count(
            &rows,
            "SELECT count(*) FROM session_events WHERE type = 'workspace.preparing'"
        ),
        1
    );
}

#[tokio::test]
async fn a_bind_to_another_chats_managed_mount_is_refused_writing_nothing() {
    // Catches the managed-owner check dropped: the bind would go on to probe the mount.
    let database = TestDatabase::new(schema_parts());
    let (service, rows) = open_service(&database).await;
    rows.execute_batch(&format!(
        "INSERT INTO repo_mounts (id, machine_id, local_path, canonical_root, origin, \
         managed_session_id, attached_at, updated_at) VALUES ('{MOUNT_ID}', 'machine', \
         '/chats/other', '/chats/other', 'managed', '{OTHER_SESSION_ID}', '{PARENT_ROWS_AT}', \
         '{PARENT_ROWS_AT}')"
    ))
    .expect("the managed mount is admitted");

    let refused = service
        .bind(&bind_request(SESSION_ID))
        .await
        .expect_err("another chat's folder is its own");

    assert_eq!(refusal_code(&refused), RefusalCode::RepoMountManaged);
    assert_eq!(count(&rows, "SELECT count(*) FROM workspaces"), 0);
    assert_eq!(count(&rows, "SELECT count(*) FROM session_events"), 0);
}

#[tokio::test]
async fn a_ready_workspace_whose_root_vanished_moves_to_root_lost_once_under_two_readers() {
    // Catches the move's one-row guard dropped: the second reader's move would then append a
    // second `workspace.rootLost`.
    let database = TestDatabase::new(schema_parts());
    let (service, rows) = open_service(&database).await;
    let temporary = tempfile::tempdir().expect("the temporary folder is made");
    let mount_root = real_path(temporary.path()).expect("the temporary folder resolves");
    let fs_root = mount_root.join("tree");
    std::fs::create_dir(&fs_root).expect("the workspace's root is made");
    insert_attached_mount(&rows, &mount_root);
    rows.execute_batch(&format!(
        "INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, fs_root, state, \
         created_at, updated_at) VALUES ('{WORKSPACE_ID}', '{SESSION_ID}', '{MOUNT_ID}', \
         'boundRoot', '{}', 'ready', '{PARENT_ROWS_AT}', '{PARENT_ROWS_AT}')",
        fs_root.to_string_lossy()
    ))
    .expect("the ready workspace is admitted");
    std::fs::remove_dir(&fs_root).expect("the root vanishes");
    let workspace_id = WorkspaceId::new(WORKSPACE_ID).expect("the id is a UUID");

    let paused = service.root_lost_pause.arm();
    let first = tokio::spawn({
        let service = Arc::clone(&service);
        async move { service.assert_writable(workspace_id).await }
    });
    paused
        .reached
        .await
        .expect("the first reader read the workspace ready");
    let second = service
        .assert_writable(workspace_id)
        .await
        .expect_err("the second reader finds the root gone");
    paused
        .release
        .send(())
        .expect("the first reader waits at its pause");
    let first = first
        .await
        .expect("the first reader's task ends")
        .expect_err("the first reader finds the root gone");

    assert_eq!(refusal_code(&first), RefusalCode::WorkspaceRootUnavailable);
    assert_eq!(refusal_code(&second), RefusalCode::WorkspaceRootUnavailable);
    assert_eq!(
        count(
            &rows,
            "SELECT count(*) FROM session_events WHERE type = 'workspace.rootLost'"
        ),
        1
    );
    let listed = service.list(&list_request()).await.expect("the list reads");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].state, WorkspaceState::RootLost);
    assert!(listed[0].last_error.is_some(), "the move records why");
}

#[tokio::test]
async fn a_retry_from_root_lost_clears_the_last_failure() {
    // Catches the begin keeping `lastError`: the retried `preparing` row would show the last
    // failure.
    let database = TestDatabase::new(schema_parts());
    let (service, rows) = open_service(&database).await;
    let (_temporary, root) = new_repository().await;
    insert_attached_mount(&rows, &root);
    let workspace_id = service
        .bind(&bind_request(SESSION_ID))
        .await
        .expect("the bind lands")
        .workspace_id;

    service
        .fail_root_preparation(workspace_id, "fatal: the worktree could not be made", None)
        .await
        .expect("the failure is recorded");
    let failed = service.list(&list_request()).await.expect("the list reads");
    assert_eq!(failed[0].state, WorkspaceState::RootLost);
    assert!(failed[0].last_error.is_some(), "the failure is kept");

    service
        .begin_root_preparation(workspace_id, ExecutionMode::BoundRoot, None)
        .await
        .expect("a lost workspace is prepared again");
    let retried = service.list(&list_request()).await.expect("the list reads");
    assert_eq!(retried[0].state, WorkspaceState::Preparing);
    assert_eq!(retried[0].last_error, None);

    service
        .complete_root_preparation(
            workspace_id,
            &CompletedRootPreparation {
                execution_root: root.clone(),
                checkout_root: root,
                execution_mode: None,
                bound_root: None,
            },
            None,
        )
        .await
        .expect("the retry completes");
    let ready = service.list(&list_request()).await.expect("the list reads");
    assert_eq!(ready[0].state, WorkspaceState::Ready);
    assert_eq!(ready[0].last_error, None);
}
