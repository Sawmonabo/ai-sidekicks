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
//! - The instant the next start walks from is stored only once every write reported before it is
//!   recorded, a report held behind an open tool call included, so a crash never skips a write.

use std::collections::{HashMap, VecDeque};
use std::error::Error;
use std::fs::File;
use std::io::{self, Read, Write as _};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::SystemTime;

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
use sidekicks_provider::port::file_tool_write::{
    FileToolWriteOpened, FileToolWriteOutcome, FileToolWritePort, FileToolWriteSettled,
};
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_std::missing_entry::is_missing_entry;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::database::stored_column::text_column;
use sidekicks_store::events::session::appender::SessionEventAppender;
use sidekicks_workspace::managed::write_watcher::{
    ManagedWorkspaceReport, ManagedWorkspaceWrite, ManagedWorkspaceWriteKind,
    ManagedWritesWatermark,
};
use tokio::sync::mpsc;

use crate::id::mint_artifact_id;
use crate::manifest_write::{PublishedManifest, manifest_created_at, write_published_manifest};
use crate::payload_store::{ContentHash, PayloadStore};
use crate::publish::{SPOOL_FILE_MODE, new_spool_path, remove_spool};
use crate::refusals::ArtifactError;
use crate::validation::{
    SpooledPayload, Utf8Check, file_name_metadata, keep_leading_bytes, validate_and_store,
};

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

/// The paths held behind open tool calls, with the caught-up instant their reports hold back.
#[derive(Default)]
struct HeldWrites {
    paths: HashMap<WorkspacePath, HeldPath>,
    /// The reports waiting on a path's calls or being recorded since they settled.
    due_reports: usize,
    /// The newest caught-up instant, stored once the last due report is recorded.
    deferred_caught_up: Option<SystemTime>,
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
pub struct ChatFileVersions {
    appender: Arc<SessionEventAppender>,
    reads: Arc<DatabaseReadPool>,
    payloads: Arc<PayloadStore>,
    spool_folder: PathBuf,
    workspaces_folder: PathBuf,
    clock: Arc<dyn WallClock>,
    held_writes: Mutex<HeldWrites>,
    /// Held per path while its next version is written, so its numbers follow its writes.
    path_lock: KeyedLock<WorkspacePath>,
    watermark: Arc<dyn ManagedWritesWatermark>,
}

impl ChatFileVersions {
    /// Versions of the writes in the chats' workspaces under `workspaces_folder`, appended through
    /// `appender`, read through `reads`, stored into `payloads` and spooled in `spool_folder`,
    /// which must be on the store's volume; each caught-up instant is stored through `watermark`.
    pub fn new(
        appender: Arc<SessionEventAppender>,
        reads: Arc<DatabaseReadPool>,
        payloads: Arc<PayloadStore>,
        spool_folder: PathBuf,
        workspaces_folder: PathBuf,
        clock: Arc<dyn WallClock>,
        watermark: Arc<dyn ManagedWritesWatermark>,
    ) -> Self {
        Self {
            appender,
            reads,
            payloads,
            spool_folder,
            workspaces_folder,
            clock,
            held_writes: Mutex::default(),
            path_lock: KeyedLock::new(),
            watermark,
        }
    }

    /// Records each write `reports` names, one at a time, until its sender is gone, and keeps
    /// each caught-up instant as [`Self::keep_caught_up`] does; a write that could not be recorded
    /// is logged, and the next one goes on.
    pub async fn record_reported_writes(
        &self,
        mut reports: mpsc::Receiver<ManagedWorkspaceReport>,
    ) {
        while let Some(report) = reports.recv().await {
            match report {
                ManagedWorkspaceReport::Write(write) => {
                    if let Err(error) = self.take_reported_write(write).await {
                        tracing::error!(
                            error = &error as &(dyn Error + 'static),
                            "a chat's write was not kept as a version"
                        );
                    }
                }
                ManagedWorkspaceReport::CaughtUp(instant) => self.keep_caught_up(instant).await,
            }
        }
    }

    /// Stores `instant`, before which every write was reported, once each report taken before it
    /// is recorded: at once when none waits behind an open tool call, else at the settle that
    /// records the last one, a later instant replacing it meanwhile. A call that never settles
    /// leaves it unstored, so the next start walks from the instant stored before.
    pub async fn keep_caught_up(&self, instant: SystemTime) {
        let is_due_now = {
            let mut held_writes = self.lock_held_writes();
            if held_writes.due_reports == 0 {
                true
            } else {
                held_writes.deferred_caught_up = Some(instant);
                false
            }
        };
        if is_due_now {
            self.watermark.store(instant).await;
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
            let mut guard = self.lock_held_writes();
            let held_writes = &mut *guard;
            if let Some(held) = held_writes.paths.get_mut(&key) {
                if !held.is_report_waiting {
                    held.is_report_waiting = true;
                    held_writes.due_reports += 1;
                }
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
        self.lock_held_writes()
            .paths
            .entry(key)
            .or_default()
            .calls
            .push_back(ToolCall {
                call_id: opened.call_id,
                outcome: None,
            });
    }

    // Records the call's outcome and every settled call ahead of the path's first open one, in the
    // order they opened, then a report that waited once none is open, and then a caught-up instant
    // that waited for that report, recorded or not.
    async fn settle_call(&self, settled: FileToolWriteSettled) -> Result<(), ChatFileVersionError> {
        let Some(key) = self.workspace_path_of(settled.session_id, &settled.path) else {
            return Ok(());
        };
        let _path_hold = self.path_lock.acquire(key.clone()).await;
        let (outcomes, is_report_due) = {
            let mut guard = self.lock_held_writes();
            let held_paths = &mut guard.paths;
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
        let recorded = self.record_settled(&key, outcomes, is_report_due).await;
        if is_report_due {
            self.finish_due_report().await;
        }
        recorded
    }

    // Records the settled calls' written bytes in order, then the path's disk when `is_report_due`.
    async fn record_settled(
        &self,
        key: &WorkspacePath,
        outcomes: Vec<FileToolWriteOutcome>,
        is_report_due: bool,
    ) -> Result<(), ChatFileVersionError> {
        for outcome in outcomes {
            if let FileToolWriteOutcome::Written(bytes) = outcome {
                self.record_version(key, PathWrite::ToolResult(bytes))
                    .await?;
            }
        }
        if is_report_due {
            self.record_version(key, PathWrite::OnDisk(ManagedWorkspaceWriteKind::File))
                .await?;
        }
        Ok(())
    }

    // Counts a due report done, and stores the caught-up instant it held back when it was the last.
    async fn finish_due_report(&self) {
        let caught_up = {
            let mut held_writes = self.lock_held_writes();
            held_writes.due_reports -= 1;
            if held_writes.due_reports == 0 {
                held_writes.deferred_caught_up.take()
            } else {
                None
            }
        };
        if let Some(instant) = caught_up {
            self.watermark.store(instant).await;
        }
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

    fn lock_held_writes(&self) -> MutexGuard<'_, HeldWrites> {
        lock(&self.held_writes)
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
mod tests;
