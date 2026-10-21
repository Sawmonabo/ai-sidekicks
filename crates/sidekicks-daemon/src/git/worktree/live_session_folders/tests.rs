use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use notify::NullWatcher;
use rusqlite::params;
use serde_json::json;
use sidekicks_contracts::repo::mount::{ExecutionMode, RepoMountId, WorkspaceState};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_platforms::WallClockTimer;
use tokio::time::timeout;

use super::{LiveSessionFolders, LiveSessionFoldersDeps};
use crate::daemon::scheduler::Scheduler;
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::writer::test_file::{TestDatabase, test_envelope, test_session_id};
use crate::events::log_service::EventLogAppendOptions;
use crate::events::log_service::tests::{TestLog, open_log};
use crate::git::process::{GitCall, GitRunner, in_folder, test_git_runner};
use crate::git::worktree::event_emitter::WorktreeEventEmitter;
use crate::git::worktree::fetch::{BackgroundFetch, BackgroundFetchDeps};
use crate::git::worktree::occupancy::MountOccupancyReader;
use crate::git::worktree::watch::{WorkingFolderWatcher, WorkingFolderWatcherDeps};
use crate::session::directory::test_rows::insert_session_row;
use crate::uuid_v7::mint_uuid_v7;
use crate::workspace::folder::canonical_path::canonical_folder_path;
use crate::workspace::test_rows::{PARENT_ROWS_AT, project_and_mount_rows};

const WAIT: Duration = Duration::from_secs(30);

// Long enough for a fetch that would wrongly start to begin.
const QUIET: Duration = Duration::from_millis(500);

const READ_STATEMENT_CAPACITY: usize = 16;

#[expect(
    clippy::unnecessary_wraps,
    reason = "it stands in for the machine's ceiling read, which can fail"
)]
fn no_ceiling() -> io::Result<Option<u64>> {
    Ok(None)
}

async fn git_in(git: &GitRunner, folder: &Path, arguments: &[&str]) {
    git.run(None, GitCall::read(in_folder(folder, arguments)))
        .await
        .expect("git runs in the test repository");
}

fn stand_in(database: &TestDatabase, session_id: &SessionId, mount: &RepoMountId, folder: &Path) {
    database
        .reader()
        .execute(
            "INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, fs_root, \
             state, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![
                mint_uuid_v7().to_string(),
                session_id.text().as_str(),
                mount.to_string(),
                <&'static str>::from(ExecutionMode::ProvisionedWorktree),
                folder.to_string_lossy(),
                <&'static str>::from(WorkspaceState::Ready),
                PARENT_ROWS_AT,
            ],
        )
        .expect("the workspace is stored");
}

async fn append(log: &TestLog, session_id: &SessionId, event: serde_json::Value) {
    let event = serde_json::from_value(event).expect("the test writes a valid event");
    log.service
        .append(
            test_envelope(*session_id, &event),
            EventLogAppendOptions::default(),
        )
        .await
        .expect("the event is appended");
}

async fn wait_for_syncs(folders: &LiveSessionFolders<NullWatcher>, count: u64) {
    timeout(
        WAIT,
        folders
            .synced
            .subscribe()
            .wait_for(|synced| *synced >= count),
    )
    .await
    .expect("the syncs end in time")
    .expect("the folders are alive");
}

fn held_folder(
    folders: &LiveSessionFolders<NullWatcher>,
    session_id: &SessionId,
) -> Option<PathBuf> {
    folders
        .lock_held()
        .get(session_id)
        .map(|held| held.folder.clone())
}

// Kills: letting the old folder's holds go before the new ones are taken, so a fetch both share
// starts again, and a syncing event left out of the followed set.
#[tokio::test]
async fn a_moved_session_holds_its_new_folder_first_and_an_archived_one_lets_both_go() {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let reads = Arc::new(DatabaseReadPool::new(
        database.path(),
        READ_STATEMENT_CAPACITY,
    ));
    let git = test_git_runner();
    let scratch = tempfile::tempdir().expect("a scratch folder");
    let checkout = scratch.path().join("app");
    let tree = scratch.path().join("tree");
    git_in(
        &git,
        scratch.path(),
        &["init", "--quiet", "--initial-branch=main", "app"],
    )
    .await;
    git_in(
        &git,
        &checkout,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgSign=false",
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "first",
        ],
    )
    .await;
    git_in(
        &git,
        &checkout,
        &[
            "worktree",
            "add",
            "--quiet",
            "-b",
            "other",
            &tree.to_string_lossy(),
        ],
    )
    .await;
    let mount_id = mint_uuid_v7().to_string();
    let connection = database.reader();
    for row in project_and_mount_rows(&mount_id, None) {
        connection
            .execute_batch(&row)
            .expect("the project and its mount are stored");
    }
    connection
        .execute(
            "UPDATE repo_mounts SET canonical_root = ?1 WHERE id = ?2",
            params![checkout.to_string_lossy(), mount_id],
        )
        .expect("the mount points at the checkout");
    let mount = RepoMountId::new(&mount_id).expect("a minted id is a mount id");
    let session_id = test_session_id();
    insert_session_row(&connection, session_id.text().as_str(), None, None);
    stand_in(&database, &session_id, &mount, &checkout);

    let scheduler = Arc::new(Scheduler::start(
        Arc::new(WallClockTimer::new().expect("the wall-clock timer is made")),
        None,
    ));
    let watcher = Arc::new(WorkingFolderWatcher::<NullWatcher>::new(
        WorkingFolderWatcherDeps {
            git: git.clone(),
            reads: Arc::clone(&reads),
            occupancy: MountOccupancyReader::new(Arc::clone(&reads)),
            events: Arc::new(WorktreeEventEmitter::new(Arc::clone(&log.service))),
            scheduler: Arc::clone(&scheduler),
            read_watch_ceiling: no_ceiling,
            slow_tick_interval: Duration::from_secs(180),
        },
    ));
    let fetch = Arc::new(BackgroundFetch::new(BackgroundFetchDeps {
        git: git.clone(),
        writer: Arc::clone(&log.writer),
        scheduler,
    }));
    let folders = Arc::new(LiveSessionFolders::new(LiveSessionFoldersDeps {
        reads,
        git,
        watcher,
        fetch: Arc::clone(&fetch),
    }));
    let mut fetch_counts = fetch.counts();

    folders
        .start(&log.followers)
        .await
        .expect("the live sessions are read");
    wait_for_syncs(&folders, 1).await;
    timeout(WAIT, fetch_counts.wait_for(|counts| counts.ended == 1))
        .await
        .expect("the first fetch ends in time")
        .expect("the fetch is alive");
    let checkout_key = canonical_folder_path(&checkout).await.expect("resolves");
    assert_eq!(held_folder(&folders, &session_id), Some(checkout_key));

    // Moved to the project's tree on the same mount.
    connection
        .execute(
            "UPDATE workspaces SET fs_root = ?1 WHERE session_id = ?2",
            params![tree.to_string_lossy(), session_id.text().as_str()],
        )
        .expect("the workspace moves");
    append(
        &log,
        &session_id,
        json!({
            "type": "workspace.prepared",
            "payload": { "sessionId": session_id, "state": "ready" },
        }),
    )
    .await;
    wait_for_syncs(&folders, 2).await;
    let tree_key = canonical_folder_path(&tree).await.expect("resolves");
    assert_eq!(held_folder(&folders, &session_id), Some(tree_key));
    assert!(
        timeout(QUIET, fetch_counts.wait_for(|counts| counts.begun >= 2))
            .await
            .is_err(),
        "the mount's fetch is held across the move, not started again"
    );

    connection
        .execute(
            "UPDATE sessions SET state = ?1 WHERE id = ?2",
            params![
                <&'static str>::from(SessionState::Archived),
                session_id.text().as_str()
            ],
        )
        .expect("the session is archived");
    append(
        &log,
        &session_id,
        json!({
            "type": "session.archived",
            "payload": { "sessionId": session_id, "newState": "archived" },
        }),
    )
    .await;
    wait_for_syncs(&folders, 3).await;
    assert_eq!(held_folder(&folders, &session_id), None);
    assert!(!fetch.is_held(&mount), "the archive lets the fetch go");

    folders.stop().await;
    fetch.stop().await;
}
