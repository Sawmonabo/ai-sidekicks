//! Every file and folder a chat writes into its managed workspace, kept as versions of its path's
//! artifact: each write a new manifest with the path's next version number, its bytes copied into
//! the store as they were at the write, so a later write never changes an earlier version.
//!
//! - The workspace's watch reports a path, not its bytes, and can merge two writes into one report,
//!   so a write the agent's own file tool made is also taken from the tool's result. A path's tool
//!   writes land in the order their calls opened, and the watch's report of a path waits while a
//!   call on it is open, then reads the disk.
//! - A report whose bytes equal the path's newest version writes nothing, so a write a tool's
//!   result already kept, a restore and a repeated report add no version.
//! - A folder is one manifest at its creation over the empty payload, and has no later version.
//! - A file gone when its report is read was removed after the write: it writes no version.
//! - The writes of one path run one at a time, so its numbers follow the order the writes landed.
//! - A path outside a chat's workspace is no chat's write, and a project session's files are its
//!   changes, never versions.

use std::collections::{HashMap, VecDeque};
use std::error::Error;
use std::fs::File;
use std::io::{self, Read, Write as _};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use bytes::Buf as _;
use futures::FutureExt as _;
use futures::future::BoxFuture;
use rusqlite::{OptionalExtension as _, named_params};
use sha2::{Digest as _, Sha256};
use sidekicks_contracts::artifacts::manifest::ArtifactType;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::ComposedText;
use sidekicks_platforms::WallClock;
use tokio::sync::mpsc;

use crate::artifacts::id::mint_artifact_id;
use crate::artifacts::manifest_write::{
    PublishedManifest, manifest_created_at, write_published_manifest,
};
use crate::artifacts::payload_store::{ContentHash, PayloadStore};
use crate::artifacts::publish::{SPOOL_FILE_MODE, new_spool_path, remove_spool};
use crate::artifacts::refusals::ArtifactError;
use crate::artifacts::validation::{
    SpooledPayload, Utf8Check, file_name_metadata, keep_leading_bytes, validate_and_store,
};
use crate::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use crate::database::stored_column::text_column;
use crate::events::session::appender::SessionEventAppender;
use crate::keyed_lock::KeyedLock;
use crate::missing_entry::is_missing_entry;
use crate::provider::port::file_tool_write::{
    FileToolWriteOpened, FileToolWriteOutcome, FileToolWritePort, FileToolWriteSettled,
};
use crate::workspace::managed::write_watcher::{ManagedWorkspaceWrite, ManagedWorkspaceWriteKind};

/// The media type a folder's manifest records.
const FOLDER_MEDIA_TYPE: &str = "inode/directory";

// How much of a file one read copies into its spool.
const COPY_CHUNK_BYTES: usize = 64 * 1024;

// The newest version's digest of a path, or none for a path with no version yet.
const NEWEST_CONTENT_HASH_SQL: &str = "SELECT content_hash FROM artifact_manifests
  WHERE session_id = @sessionId AND workspace_path = @workspacePath
  ORDER BY version_number DESC LIMIT 1";

/// One path of one chat's workspace.
type WorkspacePath = (SessionId, ComposedText);

/// A file tool's call on a path, settled or still open.
struct ToolCall {
    call_id: String,
    outcome: Option<FileToolWriteOutcome>,
}

/// What one path holds back: its open and settled tool calls in the order they opened, and
/// whether a watch report came while one was open.
#[derive(Default)]
struct HeldPath {
    calls: VecDeque<ToolCall>,
    is_report_waiting: bool,
}

/// One write to record as a path's next version.
enum PathWrite {
    /// The path's bytes on disk now, as the watch reported a write.
    OnDisk(ManagedWorkspaceWriteKind),
    /// A tool's result's bytes.
    ToolResult(bytes::Bytes),
}

/// Why a chat's write was not recorded as a version.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ChatFileVersionError {
    /// The store, the spool or the write refused or failed.
    #[error(transparent)]
    Artifact(#[from] ArtifactError),
    /// A tool's call settled that never opened.
    #[error("the file tool's call {call_id} settled without opening")]
    CallNotOpen {
        /// The provider's own id of the call.
        call_id: String,
    },
}

/// Records a chat's writes as versions of its paths' artifacts.
pub(crate) struct ChatFileVersions {
    appender: Arc<SessionEventAppender>,
    reads: Arc<DatabaseReadPool>,
    payloads: Arc<PayloadStore>,
    spool_folder: PathBuf,
    workspaces_folder: PathBuf,
    clock: Arc<dyn WallClock>,
    held_paths: Mutex<HashMap<WorkspacePath, HeldPath>>,
    /// Held per path while its next version is written, so its numbers follow its writes.
    path_lock: KeyedLock<WorkspacePath>,
}

impl ChatFileVersions {
    /// Versions of the writes in the chats' workspaces under `workspaces_folder`, appended through
    /// `appender`, read through `reads`, stored into `payloads` and spooled in `spool_folder`, which
    /// must be on the store's volume.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the daemon's start, which builds the chat's versions"
        )
    )]
    pub(crate) fn new(
        appender: Arc<SessionEventAppender>,
        reads: Arc<DatabaseReadPool>,
        payloads: Arc<PayloadStore>,
        spool_folder: PathBuf,
        workspaces_folder: PathBuf,
        clock: Arc<dyn WallClock>,
    ) -> Self {
        Self {
            appender,
            reads,
            payloads,
            spool_folder,
            workspaces_folder,
            clock,
            held_paths: Mutex::default(),
            path_lock: KeyedLock::new(),
        }
    }

    /// Records each write `writes` reports, one at a time, until its sender is gone; a write that
    /// could not be recorded is logged, and the next one goes on.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the daemon's start, which hands the workspace's watch the sender"
        )
    )]
    pub(crate) async fn record_reported_writes(
        &self,
        mut writes: mpsc::Receiver<ManagedWorkspaceWrite>,
    ) {
        while let Some(write) = writes.recv().await {
            if let Err(error) = self.take_reported_write(write).await {
                tracing::error!(
                    error = &error as &(dyn Error + 'static),
                    "a chat's write was not kept as a version"
                );
            }
        }
    }

    /// Records the watch's report of `write` as its path's next version, or holds it while a file
    /// tool's call on the path is open. Fails as the version's write fails.
    pub(crate) async fn take_reported_write(
        &self,
        write: ManagedWorkspaceWrite,
    ) -> Result<(), ChatFileVersionError> {
        let Some(path) = workspace_path_text(&write.relative_path) else {
            return Ok(());
        };
        let key = (write.session_id, path);
        let _path_hold = self.path_lock.acquire(key.clone()).await;
        {
            let mut held_paths = self.lock_held_paths();
            if let Some(held) = held_paths.get_mut(&key) {
                held.is_report_waiting = true;
                return Ok(());
            }
        }
        Ok(self
            .record_version(&key, PathWrite::OnDisk(write.kind))
            .await?)
    }

    // Holds the watch's reports of the call's path until the call settles.
    fn open_call(&self, opened: FileToolWriteOpened) {
        let Some(key) = self.workspace_path_of(opened.session_id, &opened.path) else {
            return;
        };
        self.lock_held_paths()
            .entry(key)
            .or_default()
            .calls
            .push_back(ToolCall {
                call_id: opened.call_id,
                outcome: None,
            });
    }

    // Records the call's outcome and every settled call ahead of the path's first open one, in the
    // order they opened, then a report that waited once none is open.
    async fn settle_call(&self, settled: FileToolWriteSettled) -> Result<(), ChatFileVersionError> {
        let Some(key) = self.workspace_path_of(settled.session_id, &settled.path) else {
            return Ok(());
        };
        let _path_hold = self.path_lock.acquire(key.clone()).await;
        let (outcomes, is_report_due) = {
            let mut held_paths = self.lock_held_paths();
            let call = held_paths
                .get_mut(&key)
                .and_then(|held| {
                    held.calls
                        .iter_mut()
                        .find(|call| call.call_id == settled.call_id && call.outcome.is_none())
                })
                .ok_or_else(|| ChatFileVersionError::CallNotOpen {
                    call_id: settled.call_id.clone(),
                })?;
            call.outcome = Some(settled.outcome);
            let held = held_paths
                .get_mut(&key)
                .expect("the settled call's path is held");
            let mut outcomes = Vec::new();
            while let Some(outcome) = held.calls.front_mut().and_then(|call| call.outcome.take()) {
                held.calls.pop_front();
                outcomes.push(outcome);
            }
            let is_report_due = held.calls.is_empty() && held.is_report_waiting;
            if held.calls.is_empty() {
                held_paths.remove(&key);
            }
            (outcomes, is_report_due)
        };
        for outcome in outcomes {
            if let FileToolWriteOutcome::Written(bytes) = outcome {
                self.record_version(&key, PathWrite::ToolResult(bytes))
                    .await?;
            }
        }
        if is_report_due {
            self.record_version(&key, PathWrite::OnDisk(ManagedWorkspaceWriteKind::File))
                .await?;
        }
        Ok(())
    }

    // Writes `write` as `key`'s next version, unless its bytes equal the newest one's, it is a
    // folder already kept, or its file is gone.
    async fn record_version(
        &self,
        key: &WorkspacePath,
        write: PathWrite,
    ) -> Result<(), ArtifactError> {
        let newest_content_hash = self.read_newest_content_hash(key).await?;
        let (spooled, media_type) = match write {
            PathWrite::OnDisk(ManagedWorkspaceWriteKind::Folder) => {
                if newest_content_hash.is_some() {
                    return Ok(());
                }
                let spooled = self.spool(&[][..]).await?;
                (spooled, Some(FOLDER_MEDIA_TYPE))
            }
            PathWrite::OnDisk(ManagedWorkspaceWriteKind::File) => {
                let file_path = self
                    .workspaces_folder
                    .join(key.0.to_string())
                    .join(key.1.as_str());
                let opened = tokio::task::spawn_blocking(move || match File::open(&file_path) {
                    Ok(file) => Ok(Some(file)),
                    Err(error) if is_missing_entry(&error) => Ok(None),
                    Err(error) => Err(error),
                })
                .await??;
                let Some(file) = opened else {
                    return Ok(());
                };
                (self.spool(file).await?, None)
            }
            PathWrite::ToolResult(bytes) => (self.spool(bytes.reader()).await?, None),
        };
        if newest_content_hash.as_ref() == Some(&spooled.content_hash) {
            return remove_unneeded_spool(spooled.spool_path).await;
        }
        let spool_path = spooled.spool_path.clone();
        let manifest = PublishedManifest {
            artifact_id: mint_artifact_id(),
            session_id: key.0,
            run_id: None,
            created_by: None,
            client_idempotency_key: None,
            artifact_type: ArtifactType::File,
            content_hash: spooled.content_hash.clone(),
            size_bytes: spooled.size_bytes,
            media_type: String::new(),
            natural_size: None,
            metadata: file_name_metadata(key.1.as_str()),
            workspace_path: Some(key.1.clone()),
            plan_id: None,
            created_at: manifest_created_at(self.clock.as_ref()),
        };
        let stored = validate_and_store(&self.payloads, spooled.payload, |reading| {
            write_published_manifest(
                &self.appender,
                PublishedManifest {
                    media_type: media_type.map_or(reading.media_type, str::to_owned),
                    natural_size: reading.natural_size,
                    ..manifest
                },
            )
        })
        .await;
        match stored {
            Ok(_admitted) => Ok(()),
            Err(failure) => Err(remove_spool(spool_path, failure).await),
        }
    }

    // The digest of `key`'s newest version, or none before its first.
    async fn read_newest_content_hash(
        &self,
        key: &WorkspacePath,
    ) -> Result<Option<ContentHash>, ArtifactError> {
        let (session_id, path) = key.clone();
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok(connection
                    .prepare_cached(NEWEST_CONTENT_HASH_SQL)?
                    .query_row(
                        named_params! {
                            "@sessionId": session_id.text().as_str(),
                            "@workspacePath": path.as_str(),
                        },
                        |row| text_column(row, 0, ContentHash::from_stored),
                    )
                    .optional()?)
            })
            .await
    }

    // Copies `source` into a new spool file on the blocking pool, counting what the pipeline reads
    // of it as it goes; a copy that fails deletes what it began.
    async fn spool(
        &self,
        source: impl Read + Send + 'static,
    ) -> Result<SpooledFile, ArtifactError> {
        let spool_path = new_spool_path(&self.spool_folder);
        let written_path = spool_path.clone();
        let copied =
            tokio::task::spawn_blocking(move || copy_into_spool(source, &written_path)).await;
        match copied {
            Ok(Ok(spooled)) => Ok(SpooledFile {
                payload: SpooledPayload {
                    spool_path: spool_path.clone(),
                    content_hash: spooled.content_hash.clone(),
                    leading_bytes: spooled.leading_bytes,
                    is_utf8: spooled.is_utf8,
                    declared_media_type: None,
                },
                spool_path,
                content_hash: spooled.content_hash,
                size_bytes: spooled.size_bytes,
            }),
            Ok(Err(failure)) => Err(remove_spool(spool_path, failure.into()).await),
            Err(interrupted) => Err(remove_spool(spool_path, interrupted.into()).await),
        }
    }

    // The chat's path `path` names, when it lies in the session's own workspace.
    fn workspace_path_of(&self, session_id: SessionId, path: &Path) -> Option<WorkspacePath> {
        let workspace = self.workspaces_folder.join(session_id.to_string());
        let relative_path = path.strip_prefix(workspace).ok()?;
        Some((session_id, workspace_path_text(relative_path)?))
    }

    fn lock_held_paths(&self) -> MutexGuard<'_, HashMap<WorkspacePath, HeldPath>> {
        self.held_paths
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

impl FileToolWritePort for ChatFileVersions {
    fn open_file_tool_write(
        &self,
        opened: FileToolWriteOpened,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        self.open_call(opened);
        futures::future::ready(Ok(())).boxed()
    }

    fn settle_file_tool_write(
        &self,
        settled: FileToolWriteSettled,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async move {
            self.settle_call(settled)
                .await
                .map_err(|error| Box::new(error) as Box<dyn Error + Send + Sync>)
        }
        .boxed()
    }
}

/// A spooled copy of one write, with its length.
struct SpooledFile {
    payload: SpooledPayload,
    spool_path: PathBuf,
    content_hash: ContentHash,
    size_bytes: SafeInt<0>,
}

/// What a copy into the spool counted as it went.
struct SpoolCopy {
    content_hash: ContentHash,
    leading_bytes: Vec<u8>,
    is_utf8: bool,
    size_bytes: SafeInt<0>,
}

// Copies `source` into a new private file at `spool_path`, hashing it, keeping its leading bytes
// and checking it is UTF-8 as each chunk lands.
fn copy_into_spool(mut source: impl Read, spool_path: &Path) -> io::Result<SpoolCopy> {
    sidekicks_platforms::create_private_folder(
        spool_path
            .parent()
            .expect("a spool file sits in the spool folder"),
    )?;
    let mut spool = sidekicks_platforms::create_new_file(spool_path, SPOOL_FILE_MODE)?;
    let mut hasher = Sha256::new();
    let mut utf8 = Utf8Check::default();
    let mut leading_bytes = Vec::new();
    let mut size_bytes: u64 = 0;
    let mut chunk = vec![0; COPY_CHUNK_BYTES];
    loop {
        let read = match source.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        let chunk = &chunk[..read];
        hasher.update(chunk);
        utf8.feed(chunk);
        keep_leading_bytes(&mut leading_bytes, chunk);
        spool.write_all(chunk)?;
        size_bytes += u64::try_from(read).expect("a chunk's length fits a u64");
    }
    spool.sync_all()?;
    Ok(SpoolCopy {
        content_hash: ContentHash::of_sha256(&hasher.finalize()),
        leading_bytes,
        is_utf8: utf8.is_utf8(),
        size_bytes: SafeInt::new(size_bytes)
            .ok_or_else(|| io::Error::new(io::ErrorKind::FileTooLarge, "a file past 2^53 bytes"))?,
    })
}

// Deletes a spool whose bytes equal the newest version's.
async fn remove_unneeded_spool(spool_path: PathBuf) -> Result<(), ArtifactError> {
    Ok(tokio::task::spawn_blocking(move || std::fs::remove_file(spool_path)).await??)
}

// A path inside a workspace as a version's group names it, `/` between its parts; none for the
// workspace itself.
fn workspace_path_text(relative_path: &Path) -> Option<ComposedText> {
    ComposedText::new(relative_path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;

    use sidekicks_contracts::artifacts::id::ArtifactId;
    use sidekicks_contracts::artifacts::operations::{
        ArtifactListEntry, ArtifactPayloadSelection, ArtifactReadRequest, ArtifactReadResponse,
    };
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_platforms::WallClockTimer;
    use tempfile::TempDir;

    use super::ChatFileVersions;
    use crate::artifacts::list::list_artifacts;
    use crate::artifacts::read::read_artifact;
    use crate::artifacts::test_store::ArtifactTestStore;
    use crate::provider::port::file_tool_write::{
        FileToolWriteOpened, FileToolWriteOutcome, FileToolWritePort as _, FileToolWriteSettled,
    };
    use crate::workspace::managed::write_watcher::{
        ManagedWorkspaceWrite, ManagedWorkspaceWriteKind,
    };

    /// A chat's versions over the test store, its workspace in a folder of its own.
    struct Fixture {
        store: ArtifactTestStore,
        versions: ChatFileVersions,
        workspace: PathBuf,
        _workspaces: TempDir,
    }

    /// `artifact.read` of the stored id `id` at `version`, whole when it is not `None`'s handle.
    async fn read(
        store: &ArtifactTestStore,
        id: &str,
        version: Option<u64>,
    ) -> ArtifactReadResponse {
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

    async fn fixture() -> Fixture {
        let store = ArtifactTestStore::open().await;
        let workspaces = tempfile::tempdir().expect("the test makes a temporary folder");
        let workspace = workspaces.path().join(store.session_id.to_string());
        std::fs::create_dir_all(&workspace).expect("the test makes the chat's workspace");
        let versions = ChatFileVersions::new(
            Arc::clone(&store.appender),
            Arc::clone(&store.reads),
            Arc::clone(&store.payloads),
            store.spool_folder().to_path_buf(),
            workspaces.path().to_path_buf(),
            Arc::new(WallClockTimer::new().expect("the test arms a wall clock")),
        );
        Fixture {
            store,
            versions,
            workspace,
            _workspaces: workspaces,
        }
    }

    impl Fixture {
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
                let ArtifactReadResponse::Inline(inline) =
                    read(&self.store, id, Some(version)).await
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
        let ArtifactReadResponse::Inline(first) = read(&fixture.store, &ids[2], Some(1)).await
        else {
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
}
