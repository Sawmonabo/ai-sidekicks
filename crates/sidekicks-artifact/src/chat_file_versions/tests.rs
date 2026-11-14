use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use futures::future::BoxFuture;
use rusqlite::params;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::artifacts::operations::{
    ArtifactListEntry, ArtifactPayloadSelection, ArtifactReadRequest, ArtifactReadResponse,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_platforms::WallClockTimer;
use sidekicks_provider::port::file_tool_write::{
    FileToolWriteClaim, FileToolWriteOpened, FileToolWriteOutcome, FileToolWritePort as _,
    FileToolWriteSettled,
};
use sidekicks_store::database::schema::session_directory::insert_session_row;
use sidekicks_workspace::managed::write_watcher::{
    ManagedWorkspaceReport, ManagedWorkspaceWrite, ManagedWorkspaceWriteKind,
    ManagedWritesWatermark,
};
use sidekicks_workspace::test_rows::insert_held_managed_mount;
use tempfile::TempDir;
use tokio::sync::mpsc;

use super::ChatFileVersions;
use crate::list::list_artifacts;
use crate::read::read_artifact;
use crate::test_store::ArtifactTestStore;

/// The managed mount of the store's chat's folder.
const FOLDER_MOUNT_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e80";

/// A chat handed the folder later, whose id sorts before the store's chat's, so only the bound
/// order puts the folder's own chat first.
const FRESH_SESSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e81";

/// A chat's versions over the test store, its folder held by it and bound to it.
struct Fixture {
    store: ArtifactTestStore,
    versions: ChatFileVersions,
    watermark: Arc<CountingWatermark>,
    workspace: PathBuf,
    _workspaces: TempDir,
}

/// `artifact.read` of the stored id `id` at `version`, whole when it is not `None`'s handle.
async fn read(store: &ArtifactTestStore, id: &str, version: Option<u64>) -> ArtifactReadResponse {
    read_artifact(
        &store.reads,
        &store.payloads,
        ArtifactReadRequest {
            artifact_id: ArtifactId::new(id).expect("a stored id reads"),
            version: version.and_then(SafeInt::new),
            payload_selection: ArtifactPayloadSelection::Whole {},
        },
    )
    .await
    .expect("the artifact reads")
}

/// Keeps each instant stored with the count of versions recorded when it was stored.
struct CountingWatermark {
    reader: Mutex<rusqlite::Connection>,
    stored: Mutex<Vec<(SystemTime, i64)>>,
}

impl ManagedWritesWatermark for CountingWatermark {
    fn store(&self, instant: SystemTime) -> BoxFuture<'_, ()> {
        let recorded = self
            .reader
            .lock()
            .expect("no test thread panics holding the reader")
            .query_row("SELECT count(*) FROM artifact_manifests", [], |row| {
                row.get(0)
            })
            .expect("the test counts the versions");
        self.stored
            .lock()
            .expect("no test thread panics holding the instants")
            .push((instant, recorded));
        Box::pin(async {})
    }
}

async fn fixture() -> Fixture {
    let store = ArtifactTestStore::open().await;
    let workspaces = tempfile::tempdir().expect("the test makes a temporary folder");
    let workspace = workspaces.path().join(store.session_id.to_string());
    std::fs::create_dir_all(&workspace).expect("the test makes the chat's workspace");
    let rows = store.database.reader();
    insert_held_managed_mount(
        &rows,
        FOLDER_MOUNT_ID,
        &workspace,
        store.session_id.text().as_str(),
    );
    rows.execute(
        "INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, created_at, \
         updated_at) VALUES ('founding', ?1, ?2, 'boundRoot', '2026-10-14T09:30:00.000Z', \
         '2026-10-14T09:30:00.000Z')",
        params![store.session_id.text().as_str(), FOLDER_MOUNT_ID],
    )
    .expect("the chat's workspace is admitted");
    let watermark = Arc::new(CountingWatermark {
        reader: Mutex::new(store.database.reader()),
        stored: Mutex::default(),
    });
    let versions = ChatFileVersions::new(
        Arc::clone(&store.appender),
        Arc::clone(&store.reads),
        Arc::clone(&store.payloads),
        store.spool_folder().to_path_buf(),
        workspaces.path().to_path_buf(),
        Arc::new(WallClockTimer::new().expect("the test arms a wall clock")),
        Arc::clone(&watermark) as Arc<dyn ManagedWritesWatermark>,
    );
    Fixture {
        store,
        versions,
        watermark,
        workspace,
        _workspaces: workspaces,
    }
}

impl Fixture {
    /// Sends `reports` on a closed channel and records them all.
    async fn record_reports(&self, reports: impl IntoIterator<Item = ManagedWorkspaceReport>) {
        let reports = Vec::from_iter(reports);
        let (reports_sender, receiver) = mpsc::channel(reports.len());
        for report in reports {
            reports_sender
                .send(report)
                .await
                .expect("the reports wait for their reader");
        }
        drop(reports_sender);
        self.versions.record_reported_writes(receiver).await;
    }

    /// Each instant stored so far, with the count of versions recorded when it was stored.
    fn stored_instants(&self) -> Vec<(SystemTime, i64)> {
        self.watermark
            .stored
            .lock()
            .expect("no test thread panics holding the instants")
            .clone()
    }

    /// Writes `bytes` to `name` in the workspace, as the chat would.
    fn write_file(&self, name: &str, bytes: &str) {
        std::fs::write(self.workspace.join(name), bytes).expect("the test writes a file");
    }

    /// Admits the chat [`FRESH_SESSION_ID`] holding the folder, bound to it after its own chat.
    fn add_fresh_holder(&self) -> SessionId {
        let connection = self.store.database.reader();
        insert_session_row(&connection, FRESH_SESSION_ID, None, None);
        connection
            .execute_batch(&format!(
                "INSERT INTO managed_folder_holds (repo_mount_id, session_id) \
                 VALUES ('{FOLDER_MOUNT_ID}', '{FRESH_SESSION_ID}');
                 INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, \
                 created_at, updated_at) VALUES ('fresh', '{FRESH_SESSION_ID}', \
                 '{FOLDER_MOUNT_ID}', 'boundRoot', '2026-10-14T09:31:00.000Z', \
                 '2026-10-14T09:31:00.000Z')"
            ))
            .expect("the fresh chat's hold and workspace are admitted");
        SessionId::new(FRESH_SESSION_ID).expect("a session id")
    }

    /// The watch's report of a write to `name`.
    async fn report(&self, name: &str, kind: ManagedWorkspaceWriteKind) {
        self.versions
            .take_reported_write(ManagedWorkspaceWrite {
                session_id: self.store.session_id,
                relative_path: PathBuf::from(name),
                kind,
            })
            .await
            .expect("the report is kept");
    }

    /// Opens `session_id`'s file tool's call `call_id` on `name`.
    async fn open_call(&self, session_id: SessionId, call_id: &str, name: &str) {
        self.versions
            .open_file_tool_write(FileToolWriteOpened {
                session_id,
                call_id: call_id.to_owned(),
                path: self.workspace.join(name),
            })
            .await
            .expect("the call is held");
    }

    /// Settles `session_id`'s file tool's call `call_id` on `name` with `outcome`.
    async fn settle_call(
        &self,
        session_id: SessionId,
        call_id: &str,
        name: &str,
        outcome: FileToolWriteOutcome,
    ) {
        self.versions
            .settle_file_tool_write(FileToolWriteSettled {
                session_id,
                call_id: call_id.to_owned(),
                path: self.workspace.join(name),
                outcome,
            })
            .await
            .expect("the call settles");
    }

    /// The session's file entries, each with its path, its newest media type and its count.
    async fn file_entries(&self) -> Vec<(String, serde_json::Value, u64)> {
        list_artifacts(&self.store.reads, self.store.session_id)
            .await
            .expect("the list reads")
            .artifacts
            .into_iter()
            .map(|entry| {
                let ArtifactListEntry::File {
                    manifest,
                    path,
                    version_count,
                } = entry
                else {
                    panic!("a chat's write lists as a file: {entry:?}");
                };
                let media_type = manifest.metadata.as_map()["mediaType"].0.clone();
                (path.as_str().to_owned(), media_type, version_count.get())
            })
            .collect()
    }

    /// Every version's bytes of `name`, oldest first, read as `artifact.read` answers them.
    async fn version_bytes(&self, name: &str) -> Vec<String> {
        let rows = self.store.read_rows(
            "SELECT id || ' ' || version_number FROM artifact_manifests \
             WHERE workspace_path = ?1 ORDER BY version_number",
            name,
        );
        let mut versions = Vec::new();
        for row in rows {
            let (id, version) = row.split_once(' ').expect("the row joins id and version");
            let version = version.parse().expect("a version number reads");
            let ArtifactReadResponse::Inline(inline) = read(&self.store, id, Some(version)).await
            else {
                panic!("a small payload reads inline");
            };
            versions.push(
                String::from_utf8(inline.payload.into_bytes().to_vec())
                    .expect("the test writes text"),
            );
        }
        versions
    }
}

/// A chat that writes one file three times lists it once with three versions; a read by the
/// first version's id with no version answers the third of three, written at the third write,
/// and a read of version 1 by the third's id answers the bytes first written. Each write
/// appends one `artifact.published`.
#[tokio::test]
async fn each_write_of_a_path_is_its_next_version_and_never_changes_an_earlier_one() {
    let fixture = fixture().await;
    for bytes in ["one", "two", "three"] {
        fixture.write_file("notes.txt", bytes);
        fixture
            .report("notes.txt", ManagedWorkspaceWriteKind::File)
            .await;
    }

    let ids = fixture.store.read_rows(
        "SELECT id FROM artifact_manifests WHERE workspace_path = ?1 ORDER BY version_number",
        "notes.txt",
    );
    let third_written_at = fixture.store.read_rows(
        "SELECT created_at FROM artifact_manifests \
         WHERE workspace_path = ?1 AND version_number = 3",
        "notes.txt",
    );
    let ArtifactReadResponse::Inline(newest) = read(&fixture.store, &ids[0], None).await else {
        panic!("a small payload reads inline");
    };
    let ArtifactReadResponse::Inline(first) = read(&fixture.store, &ids[2], Some(1)).await else {
        panic!("a small payload reads inline");
    };

    assert_eq!(
        fixture.file_entries().await,
        [("notes.txt".to_owned(), "text/plain".into(), 3)]
    );
    assert_eq!(
        (newest.version_number.get(), newest.version_count.get()),
        (3, 3)
    );
    assert_eq!(newest.manifest.created_at.as_str(), third_written_at[0]);
    assert_eq!(newest.payload.as_bytes(), b"three");
    assert_eq!(first.payload.as_bytes(), b"one");
    assert_eq!(fixture.store.count_events("artifact.published"), 3);
}

/// The walk's caught-up instant is stored only once the writes the watch sent ahead of it are
/// recorded, so a crash before then has the next start walk for them again; killed by storing
/// it before the reader reaches it, or never.
#[tokio::test]
async fn a_caught_up_instant_is_stored_once_the_writes_ahead_of_it_are_recorded() {
    let fixture = fixture().await;
    fixture.write_file("notes.txt", "kept");
    let caught_up = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000);

    fixture
        .record_reports([
            ManagedWorkspaceReport::Write(ManagedWorkspaceWrite {
                session_id: fixture.store.session_id,
                relative_path: PathBuf::from("notes.txt"),
                kind: ManagedWorkspaceWriteKind::File,
            }),
            ManagedWorkspaceReport::CaughtUp(caught_up),
        ])
        .await;

    assert_eq!(fixture.stored_instants(), [(caught_up, 1)]);
}

/// A caught-up instant that meets a report held behind an open file tool call is stored only once
/// the call settles and that report is recorded, and the instant stored is the latest one seen;
/// killed by storing it when the reader reaches it, never storing it, or storing the older one.
#[tokio::test]
async fn a_caught_up_instant_behind_a_held_report_is_stored_once_the_call_settles() {
    let fixture = fixture().await;
    fixture
        .open_call(fixture.store.session_id, "edit", "notes.txt")
        .await;
    fixture.write_file("notes.txt", "on disk");
    let earlier = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000);
    let latest = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000);

    fixture
        .record_reports([
            ManagedWorkspaceReport::Write(ManagedWorkspaceWrite {
                session_id: fixture.store.session_id,
                relative_path: PathBuf::from("notes.txt"),
                kind: ManagedWorkspaceWriteKind::File,
            }),
            ManagedWorkspaceReport::CaughtUp(earlier),
            ManagedWorkspaceReport::CaughtUp(latest),
        ])
        .await;
    let stored_while_held = fixture.stored_instants();
    fixture
        .settle_call(
            fixture.store.session_id,
            "edit",
            "notes.txt",
            text_claim("on disk"),
        )
        .await;

    assert_eq!(stored_while_held, []);
    assert_eq!(fixture.stored_instants(), [(latest, 1)]);
}

/// A folder is one entry over the empty payload, and a second report of it, or of a file whose
/// bytes equal its newest version's, writes no version and no event.
#[tokio::test]
async fn a_folder_and_an_unchanged_file_write_no_second_version() {
    let fixture = fixture().await;
    std::fs::create_dir(fixture.workspace.join("drafts")).expect("the test makes a folder");
    fixture.write_file("notes.txt", "same");
    for _ in 0..2 {
        fixture
            .report("drafts", ManagedWorkspaceWriteKind::Folder)
            .await;
        fixture
            .report("notes.txt", ManagedWorkspaceWriteKind::File)
            .await;
    }

    assert_eq!(
        fixture.file_entries().await,
        [
            ("drafts".to_owned(), "inode/directory".into(), 1),
            ("notes.txt".to_owned(), "text/plain".into(), 1),
        ]
    );
    assert_eq!(
        fixture.store.read_rows(
            "SELECT CAST(size_bytes AS TEXT) FROM artifact_manifests WHERE workspace_path = ?1",
            "drafts",
        ),
        ["0"]
    );
    assert_eq!(fixture.store.count_events("artifact.published"), 2);
}

/// Two file tool writes the watch merged into one report still land two versions, in the order
/// their calls opened though they settled the other way, and the report that waited for them
/// adds none when the disk holds the second; killed by counting a later call only while it is
/// still open, which drops the first claim the disk no longer holds.
#[tokio::test]
async fn tool_writes_merged_into_one_report_land_their_own_versions_in_call_order() {
    let fixture = fixture().await;
    for call_id in ["first", "second"] {
        fixture
            .open_call(fixture.store.session_id, call_id, "notes.txt")
            .await;
    }
    fixture.write_file("notes.txt", "second");
    fixture
        .report("notes.txt", ManagedWorkspaceWriteKind::File)
        .await;
    for call_id in ["second", "first"] {
        fixture
            .settle_call(
                fixture.store.session_id,
                call_id,
                "notes.txt",
                text_claim(call_id),
            )
            .await;
    }

    assert_eq!(
        fixture.version_bytes("notes.txt").await,
        ["first", "second"]
    );
}

/// A claim the disk does not hold, with no later call on its path, keeps no version, and the
/// report that waited for it records the disk once; killed by keeping the unverified claim.
#[tokio::test]
async fn an_unexplained_claim_the_disk_does_not_hold_keeps_no_version() {
    let fixture = fixture().await;
    fixture
        .open_call(fixture.store.session_id, "edit", "notes.txt")
        .await;
    fixture.write_file("notes.txt", "on disk");
    fixture
        .report("notes.txt", ManagedWorkspaceWriteKind::File)
        .await;
    fixture
        .settle_call(
            fixture.store.session_id,
            "edit",
            "notes.txt",
            text_claim("from the tool"),
        )
        .await;

    assert_eq!(fixture.version_bytes("notes.txt").await, ["on disk"]);
}

/// A patch over a moved file applies to the newest stored version of the file it came from, and
/// the disk holding the result keeps it; a patch that does not apply to the newest stored version
/// keeps nothing. Killed by applying a move's patch to its destination's version, or by keeping
/// the disk when a patch does not apply.
#[tokio::test]
async fn a_patch_applies_to_the_newest_version_of_its_base_or_keeps_nothing() {
    let fixture = fixture().await;
    for (name, bytes) in [("source.txt", "a\nb\n"), ("moved.txt", "x\n")] {
        fixture.write_file(name, bytes);
        fixture.report(name, ManagedWorkspaceWriteKind::File).await;
    }
    let patch = |base_path| {
        FileToolWriteOutcome::Claimed(FileToolWriteClaim::Patch {
            base_path,
            unified_diff: "@@ -1,2 +1,2 @@\n a\n-b\n+B\n".to_owned(),
        })
    };

    fixture
        .open_call(fixture.store.session_id, "move", "moved.txt")
        .await;
    fixture.write_file("moved.txt", "a\nB\n");
    fixture
        .settle_call(
            fixture.store.session_id,
            "move",
            "moved.txt",
            patch(Some(fixture.workspace.join("source.txt"))),
        )
        .await;
    let after_move = fixture.version_bytes("moved.txt").await;
    fixture
        .open_call(fixture.store.session_id, "update", "moved.txt")
        .await;
    fixture.write_file("moved.txt", "a\nC\n");
    fixture
        .settle_call(fixture.store.session_id, "update", "moved.txt", patch(None))
        .await;

    assert_eq!(after_move, ["x\n", "a\nB\n"]);
    assert_eq!(fixture.version_bytes("moved.txt").await, after_move);
}

/// A path of a folder two chats hold is one history: a tool's write is one version recorded on the
/// tool's chat, whose log carries its `artifact.published`; a write only the watch reports is
/// recorded on the folder's earliest live holder; each version counts on from the folder's newest;
/// and a read through any version's id counts the whole history and answers its newest under the
/// chat that recorded it. Killed by recording a version per chat, by counting versions per
/// session, by the read's count grouped by session, and by recording a watch's write on the
/// folder's namesake or the first holder by id.
#[tokio::test]
async fn a_shared_chat_folders_writes_are_one_history_each_recorded_on_its_writer() {
    let fixture = fixture().await;
    let planning = fixture.store.session_id;
    let fresh = fixture.add_fresh_holder();

    for (session_id, text) in [(fresh, "one"), (planning, "two")] {
        fixture.open_call(session_id, text, "notes.txt").await;
        fixture.write_file("notes.txt", text);
        fixture
            .settle_call(session_id, text, "notes.txt", text_claim(text))
            .await;
    }
    fixture.write_file("notes.txt", "three");
    fixture
        .report("notes.txt", ManagedWorkspaceWriteKind::File)
        .await;
    fixture
        .store
        .database
        .reader()
        .execute(
            "UPDATE sessions SET state = ?1 WHERE id = ?2",
            [
                <&'static str>::from(SessionState::PurgeRequested),
                planning.text().as_str(),
            ],
        )
        .expect("the folder's own chat is marked for purge");
    fixture.write_file("notes.txt", "four");
    fixture
        .report("notes.txt", ManagedWorkspaceWriteKind::File)
        .await;

    let versions = fixture.store.read_rows(
        "SELECT manifests.version_number || ' ' || manifests.repo_mount_id || ' ' \
                || manifests.session_id || ' ' \
                || (SELECT group_concat(events.session_id) FROM session_events AS events \
                     WHERE events.type = 'artifact.published' \
                       AND json_extract(events.payload, '$.artifactId') = manifests.id) \
           FROM artifact_manifests AS manifests \
          WHERE manifests.workspace_path = ?1 ORDER BY manifests.version_number",
        "notes.txt",
    );
    let recorded_on = |version: u8, session_id: SessionId| {
        format!("{version} {FOLDER_MOUNT_ID} {session_id} {session_id}")
    };

    assert_eq!(
        versions,
        [
            recorded_on(1, fresh),
            recorded_on(2, planning),
            recorded_on(3, planning),
            recorded_on(4, fresh),
        ]
    );
    let planning_version_id = &fixture.store.read_rows(
        "SELECT id FROM artifact_manifests WHERE workspace_path = ?1 AND version_number = 2",
        "notes.txt",
    )[0];
    let ArtifactReadResponse::Inline(newest) =
        read(&fixture.store, planning_version_id, None).await
    else {
        panic!("a small payload reads inline");
    };
    assert_eq!(
        (
            newest.version_number.get(),
            newest.version_count.get(),
            newest.manifest.session_id
        ),
        (4, 4, fresh)
    );
}

/// A file tool's claim of the whole text `text`.
fn text_claim(text: &str) -> FileToolWriteOutcome {
    FileToolWriteOutcome::Claimed(FileToolWriteClaim::Text(text.to_owned()))
}
