//! A chat's managed folder under the purge of the chats holding it: a holder's purge takes only its
//! own hold and workspace, the last holder's takes the folder and the mount with every row on it,
//! and a purge whose holders moved after its files stage keeps every row until it runs again.

use std::path::PathBuf;

use rstest::rstest;
use rusqlite::{Connection, params};
use sidekicks_contracts::repo::mount::ExecutionMode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_std::scheduler::budget::ProcessorMeter;
use sidekicks_workspace::managed::service::managed_workspaces_folder;
use sidekicks_workspace::test_rows::{PARENT_ROWS_AT, insert_held_managed_mount};

use super::{PurgeFixture, count, only_outcome, purge_fixture, state_of, store_session};
use crate::data_acts::purge::rows::PurgeCaller;
use crate::data_acts::purge::{SessionPurgeError, SessionPurgeOutcome};

const HOLDS_OF_SESSION: &str = "SELECT COUNT(*) FROM managed_folder_holds WHERE session_id = ?1";
const WORKSPACES_OF_SESSION: &str = "SELECT COUNT(*) FROM workspaces WHERE session_id = ?1";

// The planning chat's folder, which a hand-off's fresh chat holds too, each with a workspace on it.
struct SharedFolder {
    planning: SessionId,
    fresh: SessionId,
    mount_id: String,
    folder: PathBuf,
}

fn new_session_id() -> SessionId {
    SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id")
}

// Stores the archived planning and fresh chats, the folder made for the planning chat with a file
// in it, both chats' holds on it and a workspace of each on its mount.
fn shared_folder(fixture: &PurgeFixture) -> SharedFolder {
    let reader = fixture.database.reader();
    let (planning, fresh) = (new_session_id(), new_session_id());
    let mount_id = mint_uuid_v7().to_string();
    let folder = managed_workspaces_folder(fixture.home.path()).join(planning.to_string());
    std::fs::create_dir_all(&folder).expect("the chat's folder is made");
    std::fs::write(folder.join("notes.md"), "the plan's notes").expect("the file is written");
    insert_held_managed_mount(&reader, &mount_id, &folder, planning.text().as_str());
    hold(&reader, &mount_id, fresh);
    for session_id in [planning, fresh] {
        store_session(&reader, session_id, SessionState::Archived);
        reader
            .execute(
                "INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, \
                 created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                params![
                    mint_uuid_v7().to_string(),
                    session_id.text().as_str(),
                    mount_id,
                    <&'static str>::from(ExecutionMode::BoundRoot),
                    PARENT_ROWS_AT
                ],
            )
            .expect("the chat's workspace is admitted");
    }
    SharedFolder {
        planning,
        fresh,
        mount_id,
        folder,
    }
}

fn hold(connection: &Connection, mount_id: &str, session_id: SessionId) {
    connection
        .execute(
            "INSERT INTO managed_folder_holds (repo_mount_id, session_id) VALUES (?1, ?2)",
            params![mount_id, session_id.text().as_str()],
        )
        .expect("the hold is admitted");
}

// The mount's own row, its holds and its workspaces.
fn rows_on_mount(connection: &Connection, mount_id: &str) -> [i64; 3] {
    [
        "SELECT COUNT(*) FROM repo_mounts WHERE id = ?1",
        "SELECT COUNT(*) FROM managed_folder_holds WHERE repo_mount_id = ?1",
        "SELECT COUNT(*) FROM workspaces WHERE repo_mount_id = ?1",
    ]
    .map(|sql| {
        connection
            .query_row(sql, [mount_id], |row| row.get(0))
            .expect("the test counts rows")
    })
}

async fn purge_one(fixture: &PurgeFixture, session_id: SessionId) -> SessionPurgeOutcome {
    only_outcome(
        fixture
            .purge
            .purge(
                &[session_id],
                PurgeCaller::Retention,
                &ProcessorMeter::default(),
            )
            .await,
    )
}

// Kills: the folder removed while another chat holds it, the mount deleted by the purge of the
// chat it is made for while another chat holds it, the purge going by the folder's namesake in
// place of its holds (the fresh chat's purge last leaves the folder), and the last holder's purge
// leaving the folder or the mount.
#[rstest]
#[case::planning_chat_first(true)]
#[case::fresh_chat_first(false)]
#[tokio::test]
async fn a_shared_folder_goes_only_with_its_last_holders_purge(#[case] is_planning_first: bool) {
    let fixture = purge_fixture().await;
    let reader = fixture.database.reader();
    let shared = shared_folder(&fixture);
    let (first, last) = if is_planning_first {
        (shared.planning, shared.fresh)
    } else {
        (shared.fresh, shared.planning)
    };

    let outcome = purge_one(&fixture, first).await;

    assert!(
        matches!(outcome, SessionPurgeOutcome::Removed { .. }),
        "the first holder is removed, got {outcome:?}"
    );
    assert!(
        shared.folder.join("notes.md").exists(),
        "the folder stays with a holder left"
    );
    assert_eq!(rows_on_mount(&reader, &shared.mount_id), [1, 1, 1]);
    assert_eq!(count(&reader, HOLDS_OF_SESSION, first), 0);
    assert_eq!(count(&reader, WORKSPACES_OF_SESSION, first), 0);
    assert_eq!(count(&reader, HOLDS_OF_SESSION, last), 1);
    assert_eq!(count(&reader, WORKSPACES_OF_SESSION, last), 1);

    let outcome = purge_one(&fixture, last).await;

    assert!(
        matches!(outcome, SessionPurgeOutcome::Removed { .. }),
        "the last holder is removed, got {outcome:?}"
    );
    assert!(
        !shared.folder.exists(),
        "the folder goes with its last holder"
    );
    assert_eq!(rows_on_mount(&reader, &shared.mount_id), [0, 0, 0]);
}

// Kills: the guard that another chat still holds the folder left off the kept folder's write (both
// writes land, leaving the mount with no holder), and its refusal read as any other refusal.
#[tokio::test]
async fn two_holders_purged_together_leave_the_folder_to_the_one_refused() {
    let fixture = purge_fixture().await;
    let reader = fixture.database.reader();
    let shared = shared_folder(&fixture);
    let pauses = [
        fixture.purge.rows_lock_pause.arm(),
        fixture.purge.rows_lock_pause.arm(),
    ];

    let (planning_outcome, fresh_outcome, ()) = tokio::join!(
        purge_one(&fixture, shared.planning),
        purge_one(&fixture, shared.fresh),
        async {
            let mut releases = Vec::new();
            // Both files stages have read the other chat's hold before either write.
            for pause in pauses {
                pause
                    .reached
                    .await
                    .expect("the purge passed its files stage");
                releases.push(pause.release);
            }
            for release in releases {
                release.send(()).expect("the purge waits");
            }
        }
    );

    let refused = match (&planning_outcome, &fresh_outcome) {
        (
            SessionPurgeOutcome::Removed { .. },
            SessionPurgeOutcome::Refused(SessionPurgeError::FolderHoldersMoved),
        ) => shared.fresh,
        (
            SessionPurgeOutcome::Refused(SessionPurgeError::FolderHoldersMoved),
            SessionPurgeOutcome::Removed { .. },
        ) => shared.planning,
        outcomes => panic!("one holder is removed and the other refused, got {outcomes:?}"),
    };
    assert!(
        shared.folder.join("notes.md").exists(),
        "both files stages kept the folder"
    );
    assert_eq!(rows_on_mount(&reader, &shared.mount_id), [1, 1, 1]);
    assert_eq!(
        state_of(&reader, refused).as_deref(),
        Some(<&'static str>::from(SessionState::PurgeRequested))
    );

    let outcome = purge_one(&fixture, refused).await;

    assert!(
        matches!(outcome, SessionPurgeOutcome::Removed { .. }),
        "the refused holder finishes as the last one, got {outcome:?}"
    );
    assert!(
        !shared.folder.exists(),
        "the folder goes with its last holder"
    );
    assert_eq!(rows_on_mount(&reader, &shared.mount_id), [0, 0, 0]);
}

// Kills: the guard that no other chat holds the folder left off the last holder's write (the
// mount and the new hold are deleted).
#[tokio::test]
async fn a_hold_taken_after_the_last_holders_files_stage_refuses_its_write() {
    let fixture = purge_fixture().await;
    let reader = fixture.database.reader();
    let shared = shared_folder(&fixture);
    let first = purge_one(&fixture, shared.fresh).await;
    assert!(
        matches!(first, SessionPurgeOutcome::Removed { .. }),
        "the fresh chat is removed first, got {first:?}"
    );
    let before_lock = fixture.purge.rows_lock_pause.arm();
    let late = new_session_id();

    let (outcome, ()) = tokio::join!(purge_one(&fixture, shared.planning), async {
        before_lock
            .reached
            .await
            .expect("the purge passed its files stage");
        hold(&reader, &shared.mount_id, late);
        before_lock.release.send(()).expect("the purge waits");
    });

    assert!(
        matches!(
            outcome,
            SessionPurgeOutcome::Refused(SessionPurgeError::FolderHoldersMoved)
        ),
        "the write is refused once another chat holds the folder, got {outcome:?}"
    );
    assert_eq!(rows_on_mount(&reader, &shared.mount_id), [1, 2, 1]);
    assert_eq!(count(&reader, HOLDS_OF_SESSION, late), 1);
}
