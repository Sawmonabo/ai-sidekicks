use std::sync::Arc;

use rusqlite::Connection;
use sidekicks_contracts::machine::id::MachineId;
use sidekicks_contracts::repo::mount::{ExecutionMode, RepoMountId, RepoMountState, WorkspaceId};
use sidekicks_contracts::session::id::SessionId;

use super::detach::DetachRepoMount;
use super::{REPO_MOUNT_SERVICE_STATEMENT_CAPACITY, RepoMountService, RepoMountServiceError};
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::TestDatabase;
use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use crate::events::log_service::{
    EVENT_LOG_STATEMENT_CAPACITY, EventLogService, EventLogServiceDependencies,
};
use crate::events::session::followers::SessionEventFollowers;
use crate::git::process::test_git_runner;
use crate::workspace::event_emitter::WorkspaceEventEmitter;
use crate::workspace::repo::errors::RepoRefusal;
use crate::workspace::repo::root_resolver::RepoRootResolver;
use crate::workspace::test_rows::{PARENT_ROWS_AT, project_and_mount_rows};

const MOUNT_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e60";
const WORKSPACE_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e61";
const SESSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e62";

/// The service over a test database holding an attached mount with one workspace on it, and a
/// connection the test writes rows through.
async fn open_service(database: &TestDatabase) -> (Arc<RepoMountService>, Connection) {
    let writer = Arc::new(
        DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens the test database"),
    );
    let reads = Arc::new(DatabaseReadPool::new(
        database.path(),
        EVENT_LOG_STATEMENT_CAPACITY + REPO_MOUNT_SERVICE_STATEMENT_CAPACITY,
    ));
    let event_log = Arc::new(EventLogService::new(EventLogServiceDependencies {
        writer: Arc::clone(&writer),
        pool: Arc::clone(&reads),
        followers: Arc::new(SessionEventFollowers::default()),
        projection_statements: None,
        refuse_session_write: None,
        read_damaged_from_sequence: None,
    }));
    let rows = database.reader();
    let bound_root = <&'static str>::from(ExecutionMode::BoundRoot);
    let workspace = format!(
        "INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, created_at, \
         updated_at) VALUES ('{WORKSPACE_ID}', '{SESSION_ID}', '{MOUNT_ID}', '{bound_root}', \
         '{PARENT_ROWS_AT}', '{PARENT_ROWS_AT}')"
    );
    for row in project_and_mount_rows(MOUNT_ID, None)
        .iter()
        .chain([&workspace])
    {
        rows.execute_batch(row).expect("a parent row is admitted");
    }
    let service = RepoMountService::new(
        writer,
        reads,
        Arc::new(WorkspaceEventEmitter::new(event_log)),
        RepoRootResolver::new(test_git_runner()),
        MachineId::new("machine".to_owned()).expect("the id is short"),
    );
    (Arc::new(service), rows)
}

fn detach_request() -> DetachRepoMount {
    DetachRepoMount {
        repo_mount_id: RepoMountId::new(MOUNT_ID).expect("the id is a UUID"),
        actor: None,
        correlation_id: None,
    }
}

#[tokio::test]
async fn a_detach_while_an_agent_runs_in_the_project_names_its_session() {
    // Catches a refused running check read as a plain write failure instead of the conflict.
    let database = TestDatabase::new();
    let (service, rows) = open_service(&database).await;
    rows.execute_batch(&format!(
        "INSERT INTO branch_contexts (id, workspace_id, base_branch, head_branch, created_at, \
         updated_at) VALUES ('branch-context', '{WORKSPACE_ID}', 'main', 'main', \
         '{PARENT_ROWS_AT}', '{PARENT_ROWS_AT}');
         INSERT INTO run_execution_contexts (run_id, session_id, workspace_id, execution_mode, \
         execution_root, checkout_root, git_common_dir, branch_context_id, created_at) VALUES \
         ('run', '{SESSION_ID}', '{WORKSPACE_ID}', 'boundRoot', '/repos/app', '/repos/app', \
         '/repos/app/.git', 'branch-context', '{PARENT_ROWS_AT}')"
    ))
    .expect("the running run's rows are admitted");

    let refusal = service
        .detach(detach_request(), Vec::new())
        .await
        .expect_err("a running agent holds the folder");

    let RepoMountServiceError::Refused(RepoRefusal::DetachConflict { running_session_id }) =
        refusal
    else {
        panic!("the detach is refused as a conflict, not {refusal:?}");
    };
    assert_eq!(
        running_session_id,
        SessionId::new(SESSION_ID).expect("the id is a UUID")
    );
}

#[tokio::test]
async fn a_detach_that_loses_its_flip_reports_the_state_the_winner_left() {
    // Catches a flip lost to a concurrent detach read as a failure instead of the mount's state.
    let database = TestDatabase::new();
    let (service, _rows) = open_service(&database).await;
    let paused = service.detach_pause.arm();
    let loser = tokio::spawn({
        let service = Arc::clone(&service);
        async move { service.detach(detach_request(), Vec::new()).await }
    });
    paused
        .reached
        .await
        .expect("the first detach read the mount attached");

    let winner = service
        .detach(detach_request(), Vec::new())
        .await
        .expect("the second detach flips the mount");
    paused
        .release
        .send(())
        .expect("the first detach waits at its pause");
    let lost = loser
        .await
        .expect("the first detach's task ends")
        .expect("a lost flip is no failure");

    assert_eq!(winner.state, RepoMountState::Detached);
    assert_eq!(
        winner.archived_workspace_ids,
        [WorkspaceId::new(WORKSPACE_ID).expect("the id is a UUID")]
    );
    assert_eq!(lost.state, RepoMountState::Detached);
    assert!(lost.archived_workspace_ids.is_empty());
}
