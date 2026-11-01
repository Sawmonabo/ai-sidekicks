use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use futures::future::BoxFuture;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::artifacts::operations::{
    ArtifactListEntry, ArtifactPayloadSelection, ArtifactReadRequest, ArtifactReadResponse,
};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_platforms::WallClockTimer;
use sidekicks_provider::port::file_tool_write::{
    FileToolWriteOpened, FileToolWriteOutcome, FileToolWritePort as _, FileToolWriteSettled,
};
use sidekicks_workspace::managed::write_watcher::{
    ManagedWorkspaceReport, ManagedWorkspaceWrite, ManagedWorkspaceWriteKind,
    ManagedWritesWatermark,
};
use tempfile::TempDir;
use tokio::sync::mpsc;

use super::ChatFileVersions;
use crate::list::list_artifacts;
use crate::read::read_artifact;
use crate::test_store::ArtifactTestStore;

/// A chat's versions over the test store, its workspace in a folder of its own.
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
    let path = fixture.workspace.join("notes.txt");
    fixture
        .versions
        .open_file_tool_write(FileToolWriteOpened {
            session_id: fixture.store.session_id,
            call_id: "edit".to_owned(),
            path: path.clone(),
        })
        .await
        .expect("the call is held");
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
        .versions
        .settle_file_tool_write(FileToolWriteSettled {
            session_id: fixture.store.session_id,
            call_id: "edit".to_owned(),
            path,
            outcome: FileToolWriteOutcome::Written(bytes::Bytes::from("from the tool")),
        })
        .await
        .expect("the call settles");

    assert_eq!(stored_while_held, []);
    assert_eq!(fixture.stored_instants(), [(latest, 2)]);
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
/// adds none when the disk holds the second.
#[tokio::test]
async fn tool_writes_merged_into_one_report_land_their_own_versions_in_call_order() {
    let fixture = fixture().await;
    let path = fixture.workspace.join("notes.txt");
    for call_id in ["first", "second"] {
        fixture
            .versions
            .open_file_tool_write(FileToolWriteOpened {
                session_id: fixture.store.session_id,
                call_id: call_id.to_owned(),
                path: path.clone(),
            })
            .await
            .expect("the call is held");
    }
    fixture.write_file("notes.txt", "second");
    fixture
        .report("notes.txt", ManagedWorkspaceWriteKind::File)
        .await;
    for (call_id, bytes) in [("second", "second"), ("first", "first")] {
        fixture
            .versions
            .settle_file_tool_write(FileToolWriteSettled {
                session_id: fixture.store.session_id,
                call_id: call_id.to_owned(),
                path: path.clone(),
                outcome: FileToolWriteOutcome::Written(bytes::Bytes::from(bytes)),
            })
            .await
            .expect("the call settles");
    }

    assert_eq!(
        fixture.version_bytes("notes.txt").await,
        ["first", "second"]
    );
}
