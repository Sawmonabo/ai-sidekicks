//! A chat's managed folder under the purge of the chats holding it: a holder's purge takes only its
//! own hold and workspace and hands its file versions to the holder left, the last holder's takes
//! the folder, every version and the mount with every row on it, and a purge whose holders moved
//! after its files stage keeps every row until it runs again.

use std::path::PathBuf;

use rstest::rstest;
use rusqlite::{Connection, params};
use sha2::{Digest as _, Sha256};
use sidekicks_artifact::list::list_artifacts;
use sidekicks_artifact::payload_store::{ContentHash, PayloadStore};
use sidekicks_artifact::read::read_artifact;
use sidekicks_artifact::schema::ARTIFACT_STATEMENT_CAPACITY;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::artifacts::operations::{
    ArtifactListEntry, ArtifactPayloadSelection, ArtifactReadRequest, ArtifactReadResponse,
};
use sidekicks_contracts::repo::mount::ExecutionMode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_std::scheduler::budget::ProcessorMeter;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
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

// One version of the folder's `notes.md` holding `bytes`, recorded on `session_id`, its payload in
// the store the purge reclaims from; answers the manifest's id and where its payload is stored.
async fn store_version(
    fixture: &PurgeFixture,
    shared: &SharedFolder,
    session_id: SessionId,
    version_number: i64,
    bytes: &[u8],
) -> (String, PathBuf) {
    let payloads =
        PayloadStore::new(fixture.home.path().join("objects")).expect("the payload store opens");
    let content_hash = ContentHash::of_sha256(&Sha256::digest(bytes));
    let spool = fixture.home.path().join(format!("spool-{version_number}"));
    std::fs::write(&spool, bytes).expect("the spool is written");
    payloads
        .admit(spool, &content_hash, async { Ok(()) })
        .await
        .expect("the bytes are stored");
    let manifest_id = mint_uuid_v7().to_string();
    let size = i64::try_from(bytes.len()).expect("a small file");
    let reader = fixture.database.reader();
    reader
        .execute(
            "INSERT INTO artifact_manifests (id, session_id, artifact_type, content_hash, \
             size_bytes, workspace_path, repo_mount_id, version_number, created_at) \
             VALUES (?1, ?2, 'file', ?3, ?4, 'notes.md', ?5, ?6, ?7)",
            params![
                manifest_id,
                session_id.text().as_str(),
                content_hash.as_str(),
                size,
                shared.mount_id,
                version_number,
                PARENT_ROWS_AT
            ],
        )
        .expect("the version is written");
    reader
        .execute(
            "INSERT INTO artifact_payload_refs (id, manifest_id, storage_path, media_type, \
             size_bytes, created_at) VALUES (?1, ?2, ?3, 'text/markdown', ?4, ?5)",
            params![
                mint_uuid_v7().to_string(),
                manifest_id,
                content_hash.as_str(),
                size,
                PARENT_ROWS_AT
            ],
        )
        .expect("the version's payload reference is written");
    (manifest_id, payloads.object_path_of(&content_hash))
}

// The version count `session_id`'s list gives the folder's `notes.md`.
async fn listed_count(reads: &DatabaseReadPool, session_id: SessionId) -> Vec<u64> {
    list_artifacts(reads, session_id)
        .await
        .expect("the list reads")
        .artifacts
        .into_iter()
        .map(|entry| match entry {
            ArtifactListEntry::File { version_count, .. } => version_count.get(),
            entry @ ArtifactListEntry::Plan { .. } => panic!("no plan is stored: {entry:?}"),
        })
        .collect()
}

// The chat that recorded version `version`, read through the id `manifest_id`, and its bytes.
async fn read_version(
    fixture: &PurgeFixture,
    reads: &DatabaseReadPool,
    manifest_id: &str,
    version: u64,
) -> (SessionId, Vec<u8>) {
    let payloads =
        PayloadStore::new(fixture.home.path().join("objects")).expect("the payload store opens");
    let ArtifactReadResponse::Inline(inline) = read_artifact(
        reads,
        &payloads,
        ArtifactReadRequest {
            artifact_id: ArtifactId::new(manifest_id).expect("a stored id reads"),
            version: SafeInt::new(version),
            payload_selection: ArtifactPayloadSelection::Whole {},
        },
    )
    .await
    .expect("the version reads") else {
        panic!("a small payload reads inline");
    };
    (
        inline.manifest.session_id,
        inline.payload.as_bytes().to_vec(),
    )
}

// Both holders list the folder's two versions, one recorded on each; the planning chat's purge
// hands its version to the fresh chat with its payload kept, and the fresh chat's purge takes every
// version and payload. Kills: the history purged with its namesake, a payload unlinked under a
// kept version, the list read by the session in place of its folder, and the last holder's purge
// leaving the folder's versions or their payloads.
#[tokio::test]
async fn a_shared_folders_versions_stay_with_a_holder_and_go_with_the_last() {
    let fixture = purge_fixture().await;
    let reader = fixture.database.reader();
    let shared = shared_folder(&fixture);
    let reads = DatabaseReadPool::new(fixture.database.path(), ARTIFACT_STATEMENT_CAPACITY);
    let (first_id, first_payload) = store_version(
        &fixture,
        &shared,
        shared.planning,
        1,
        b"the planning chat's notes",
    )
    .await;
    let (_, second_payload) = store_version(
        &fixture,
        &shared,
        shared.fresh,
        2,
        b"the fresh chat's notes",
    )
    .await;
    assert_eq!(listed_count(&reads, shared.planning).await, [2]);
    assert_eq!(listed_count(&reads, shared.fresh).await, [2]);

    let outcome = purge_one(&fixture, shared.planning).await;

    assert!(
        matches!(outcome, SessionPurgeOutcome::Removed { .. }),
        "the planning chat is removed, got {outcome:?}"
    );
    assert_eq!(listed_count(&reads, shared.fresh).await, [2]);
    assert_eq!(
        read_version(&fixture, &reads, &first_id, 1).await,
        (shared.fresh, b"the planning chat's notes".to_vec())
    );
    assert!(first_payload.exists() && second_payload.exists());

    let outcome = purge_one(&fixture, shared.fresh).await;

    assert!(
        matches!(outcome, SessionPurgeOutcome::Removed { .. }),
        "the fresh chat is removed, got {outcome:?}"
    );
    let versions_on_mount: i64 = reader
        .query_row(
            "SELECT COUNT(*) FROM artifact_manifests WHERE repo_mount_id = ?1",
            [&shared.mount_id],
            |row| row.get(0),
        )
        .expect("the test counts the versions");
    let references: i64 = reader
        .query_row("SELECT COUNT(*) FROM artifact_payload_refs", [], |row| {
            row.get(0)
        })
        .expect("the test counts the references");
    assert_eq!((versions_on_mount, references), (0, 0));
    assert!(!first_payload.exists() && !second_payload.exists());
}
