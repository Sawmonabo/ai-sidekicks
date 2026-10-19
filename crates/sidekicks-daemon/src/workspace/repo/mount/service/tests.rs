use std::path::PathBuf;
use std::sync::Arc;

use rusqlite::Connection;
use sidekicks_contracts::free_form_string::{FILE_PATH_MAX_LEN, FilesystemPath};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::machine::id::MachineId;
use sidekicks_contracts::repo::folders::RepoMountAttachRequest;
use sidekicks_contracts::repo::mount::{
    ExecutionMode, RepoMountHealth, RepoMountId, RepoMountState, WorkspaceId,
};
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
use crate::file::bounded_read::stall_reads_of;
use crate::git::process::test_git_runner;
use crate::ipc::domain_error::DomainError;
use crate::workspace::event_emitter::WorkspaceEventEmitter;
use crate::workspace::repo::errors::RepoRefusal;
use crate::workspace::repo::root_resolver::{RepoRootResolution, RepoRootResolver};
use crate::workspace::test_rows::{PARENT_ROWS_AT, project_and_mount_rows};

const MOUNT_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e60";
const WORKSPACE_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e61";
const SESSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e62";

/// The service over a test database holding an attached mount with one workspace on it, and a
/// connection the test writes rows through.
async fn open_service(database: &TestDatabase) -> (Arc<RepoMountService>, Connection) {
    open_service_resolving(database, RepoRootResolver::new(test_git_runner())).await
}

/// [`open_service`] with its picks resolved by `resolver`.
async fn open_service_resolving(
    database: &TestDatabase,
    resolver: RepoRootResolver,
) -> (Arc<RepoMountService>, Connection) {
    let service = RepoMountService::for_test(database, resolver).await;
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
    (service, rows)
}

fn detach_request() -> DetachRepoMount {
    DetachRepoMount {
        repo_mount_id: RepoMountId::new(MOUNT_ID).expect("the id is a UUID"),
        actor: None,
        correlation_id: None,
    }
}

/// Stores a run of the mount's session in its workspace, unreleased, as an agent running there.
fn insert_running_run(rows: &Connection) {
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
}

#[tokio::test]
async fn a_detach_while_an_agent_runs_in_the_project_names_its_session() {
    // Catches a refused running check read as a plain write failure instead of the conflict.
    let database = TestDatabase::new();
    let (service, rows) = open_service(&database).await;
    insert_running_run(&rows);

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

#[tokio::test]
async fn a_read_whose_root_never_answers_reads_the_mount_unreachable() {
    // Catches a root probe awaited past the ceiling, or a mount left healthy without its probe.
    let database = TestDatabase::new();
    let (service, rows) = open_service(&database).await;
    let temporary = tempfile::tempdir().expect("the temporary folder is made");
    let root = temporary.path().join("app");
    std::fs::create_dir(&root).expect("the mount's root is made");
    rows.execute(
        "UPDATE repo_mounts SET canonical_root = ?1 WHERE id = ?2",
        (root.to_string_lossy(), MOUNT_ID),
    )
    .expect("the mount's root is stored");
    let mount_id = RepoMountId::new(MOUNT_ID).expect("the id is a UUID");
    let answered = service
        .read(mount_id.clone())
        .await
        .expect("the reachable mount reads");
    assert!(
        matches!(answered.health, RepoMountHealth::Healthy { .. }),
        "{answered:?}"
    );

    let _held = stall_reads_of(&root, 0);
    let held = service
        .read(mount_id)
        .await
        .expect("a held root still reads");

    assert!(
        matches!(held.health, RepoMountHealth::Unreachable { .. }),
        "{held:?}"
    );
}

#[tokio::test]
async fn an_attach_whose_root_resolves_past_the_path_cap_is_refused_before_any_write() {
    // Catches a resolved root kept unchecked until the reply, or refused under another code.
    let database = TestDatabase::new();
    let long_root = PathBuf::from(format!("/{}", "a".repeat(FILE_PATH_MAX_LEN)));
    let resolver = RepoRootResolver::answering(
        test_git_runner(),
        RepoRootResolution {
            canonical_root: long_root.clone(),
            working_tree_root: long_root.clone(),
            common_folder: long_root.join(".git"),
        },
    );
    let (service, _rows) = open_service_resolving(&database, resolver).await;
    let request = RepoMountAttachRequest {
        local_path: FilesystemPath::new("/repos/linked".to_owned()).expect("the path is short"),
        place: None,
    };

    let refusal = service
        .resolve_attach_target(&request)
        .await
        .expect_err("the resolved root is past the cap");

    let RepoMountServiceError::Refused(refusal) = refusal else {
        panic!("the attach is refused, not {refusal:?}");
    };
    let refusal = DomainError::from(refusal);
    assert_eq!(refusal.code, RefusalCode::RequestParamsInvalid);
    let issue = &refusal.detail.expect("the refusal names its issue")["issues"][0];
    assert_eq!(issue["path"], serde_json::json!(["localPath"]));
    let length = (FILE_PATH_MAX_LEN + 1).to_string();
    assert!(
        issue["message"]
            .as_str()
            .is_some_and(|message| message.contains(&length)),
        "{issue}"
    );
}

#[tokio::test]
async fn a_detach_whose_run_ends_before_its_session_is_read_detaches_on_its_retry() {
    // Catches a run that ended between the running check and the read of its session answered as
    // the write's failure instead of tried again.
    let database = TestDatabase::new();
    let (service, rows) = open_service(&database).await;
    insert_running_run(&rows);
    let paused = service.running_read_pause.arm();
    let detaching = tokio::spawn({
        let service = Arc::clone(&service);
        async move { service.detach(detach_request(), Vec::new()).await }
    });
    paused
        .reached
        .await
        .expect("the running check refused the detach");

    rows.execute_batch(&format!(
        "UPDATE run_execution_contexts SET released_at = '{PARENT_ROWS_AT}' WHERE run_id = 'run'"
    ))
    .expect("the run ends");
    paused
        .release
        .send(())
        .expect("the detach waits at its pause");
    let outcome = detaching
        .await
        .expect("the detach's task ends")
        .expect("the detach tried again finds no run");

    assert_eq!(outcome.state, RepoMountState::Detached);
    assert_eq!(
        outcome.archived_workspace_ids,
        [WorkspaceId::new(WORKSPACE_ID).expect("the id is a UUID")]
    );
}

#[tokio::test]
async fn a_detach_whose_archived_workspace_does_not_read_reports_it_committed() {
    // Catches a committed detach whose archived rows do not read reported as a failed row read,
    // which tells the caller nothing was written.
    let database = TestDatabase::new();
    let (service, rows) = open_service(&database).await;
    let bound_root = <&'static str>::from(ExecutionMode::BoundRoot);
    rows.execute_batch(&format!(
        "INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, created_at, \
         updated_at) VALUES ('no-uuid', '0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e63', '{MOUNT_ID}', \
         '{bound_root}', '{PARENT_ROWS_AT}', '{PARENT_ROWS_AT}')"
    ))
    .expect("a workspace whose id the contracts refuse is stored");

    let failure = service
        .detach(detach_request(), Vec::new())
        .await
        .expect_err("the archived workspace does not read");

    assert!(
        matches!(failure, RepoMountServiceError::DetachArchivalsUnread { .. }),
        "{failure:?}"
    );
    let mount = service
        .read_row(RepoMountId::new(MOUNT_ID).expect("the id is a UUID"))
        .await
        .expect("the mount reads");
    assert_eq!(mount.state, RepoMountState::Detached);
}
