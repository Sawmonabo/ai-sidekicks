use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::repo::mount::{ExecutionMode, RepoMountId};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::recovery::SessionRebuildingDetails;
use tokio_util::sync::CancellationToken;

use super::{REPO_MOUNT_HEALTH_REPROBE_STATEMENT_CAPACITY, RepoMountHealthReprobe};
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::{TestDatabase, test_session_id};
use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use crate::events::log_service::{
    EVENT_LOG_STATEMENT_CAPACITY, EventLogService, EventLogServiceDependencies,
    SessionAppendRefusal,
};
use crate::events::session::followers::SessionEventFollowers;
use crate::git::process::test_git_runner;
use crate::workspace::event_emitter::WorkspaceEventEmitter;
use crate::workspace::repo::root_resolver::RepoRootResolver;
use crate::workspace::test_rows::{PARENT_ROWS_AT, project_and_mount_rows};
use sidekicks_contracts::wire::id::mint_uuid_v7;

// The `repoMount.health.changed` rows `session_id`'s log holds.
fn heard(rows: &Connection, session_id: SessionId) -> i64 {
    rows.query_row(
        "SELECT COUNT(*) FROM session_events WHERE session_id = ?1 AND type = ?2",
        [
            session_id.text().as_str(),
            SessionEventType::RepoMountHealthChanged.as_str(),
        ],
        |row| row.get(0),
    )
    .expect("the test counts the log's rows")
}

// Catches a change sent twice to a session, a session never told, or a failed send not retried.
#[tokio::test]
async fn a_changed_mount_health_reaches_each_session_once_and_a_failed_send_is_sent_again() {
    let database = TestDatabase::new(crate::git::worktree::schema::schema_parts());
    let writer = Arc::new(
        DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens the test database"),
    );
    let reads = Arc::new(DatabaseReadPool::new(
        database.path(),
        EVENT_LOG_STATEMENT_CAPACITY + REPO_MOUNT_HEALTH_REPROBE_STATEMENT_CAPACITY,
    ));
    // A session's appends are refused while it is named here, as a session that takes no
    // more events refuses them.
    let refused: Arc<Mutex<Option<SessionId>>> = Arc::default();
    let refusing = Arc::clone(&refused);
    let event_log = Arc::new(EventLogService::new(EventLogServiceDependencies {
        writer,
        pool: Arc::clone(&reads),
        followers: Arc::new(SessionEventFollowers::default()),
        projection_statements: None,
        refuse_session_write: Some(Box::new(
            move |session_id: &SessionId, _event_type: &str| {
                if *refusing.lock().expect("no holder panics") == Some(*session_id) {
                    Err(SessionAppendRefusal::Rebuilding {
                        message: "the test refuses this session's appends".to_owned(),
                        details: SessionRebuildingDetails {
                            session_id: *session_id,
                        },
                    })
                } else {
                    Ok(())
                }
            },
        )),
        read_damaged_from_sequence: None,
    }));

    let folder = tempfile::tempdir().expect("the temporary folder is made");
    let root = folder.path().join("project");
    std::fs::create_dir(&root).expect("the mount's root is made");
    let repo_mount_id =
        RepoMountId::try_from(mint_uuid_v7()).expect("a minted UUID is a repo mount id");
    let mount_text = repo_mount_id.text();
    let (first, second) = (test_session_id(), test_session_id());
    let rows = database.reader();
    for row in project_and_mount_rows(mount_text.as_str(), None) {
        rows.execute_batch(&row)
            .expect("the mount's rows are stored");
    }
    rows.execute(
        "UPDATE repo_mounts SET canonical_root = ?1 WHERE id = ?2",
        [
            root.to_str().expect("the temporary folder's path is UTF-8"),
            mount_text.as_str(),
        ],
    )
    .expect("the mount roots at the temporary folder");
    for session_id in [first, second] {
        let workspace_id = mint_uuid_v7().to_string();
        let session_text = session_id.text();
        rows.execute(
            "INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, \
             created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            [
                workspace_id.as_str(),
                session_text.as_str(),
                mount_text.as_str(),
                <&'static str>::from(ExecutionMode::BoundRoot),
                PARENT_ROWS_AT,
            ],
        )
        .expect("a session's workspace on the mount is stored");
    }
    let reprobe = RepoMountHealthReprobe::new(
        reads,
        Arc::new(WorkspaceEventEmitter::new(event_log)),
        RepoRootResolver::new(test_git_runner()),
        CancellationToken::new(),
    );

    reprobe
        .reprobe()
        .await
        .expect("a mount still healthy sends nothing");
    assert_eq!((heard(&rows, first), heard(&rows, second)), (0, 0));

    std::fs::remove_dir(&root).expect("the mount's root is removed");
    *refused.lock().expect("no holder panics") = Some(second);
    assert!(
        reprobe.reprobe().await.is_err(),
        "the refused send fails the pass"
    );
    assert_eq!((heard(&rows, first), heard(&rows, second)), (1, 0));

    *refused.lock().expect("no holder panics") = None;
    reprobe
        .reprobe()
        .await
        .expect("the change the refused session missed is sent");
    assert_eq!((heard(&rows, first), heard(&rows, second)), (1, 1));
}
