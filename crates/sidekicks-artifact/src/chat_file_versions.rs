//! Every file and folder written into a chat folder, kept as versions of its path's artifact: each
//! write a new manifest with the path's next version number, its bytes copied into the store as
//! they were at the write, so a later write never changes an earlier version.
//!
//! - A chat folder is held by every chat working in it, and its paths' versions are the folder's:
//!   one count per path whichever holder wrote it. A version is recorded once, on the chat whose
//!   tool made the write, else, for a write only the watch reports, on the folder's earliest live
//!   holder; that chat's log carries its `artifact.published`.
//! - The workspace's watch reports a path, not its bytes, and can merge two writes into one report,
//!   so each call of the agent's own file tool is kept too: its result claims what the file holds
//!   after it, a whole text or a patch over the newest stored version of the file it came from, and
//!   the claim is checked against the disk. A claim the disk holds keeps the disk's bytes; one the
//!   disk does not hold keeps its text in the disk file's form when a later call on the path
//!   explains the difference, and nothing otherwise. A path's tool writes land in the order their
//!   calls opened, and the watch's report of a path waits while a call on it is open, then reads
//!   the disk.
//! - A report whose bytes equal the path's newest version writes nothing, so a write a tool's call
//!   already kept, a restore and a repeated report add no version.
//! - A folder is one manifest at its creation over the empty payload, and has no later version.
//! - A file gone when its report is read was removed after the write: it writes no version.
//! - The writes of one path run one at a time, so its numbers follow the order the writes landed.
//! - A path outside a chat folder the tool's chat holds is no chat's write, and a project session's
//!   files are its changes, never versions.
//! - The instant the next start walks from is stored only once every write reported before it is
//!   recorded, a report held behind an open tool call included, so a crash never skips a write.

use std::collections::{HashMap, VecDeque};
use std::error::Error;
use std::fs::File;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::SystemTime;

use bytes::Buf as _;
use futures::FutureExt as _;
use futures::future::BoxFuture;
use rusqlite::{OptionalExtension as _, named_params};
use sidekicks_contracts::artifacts::manifest::ArtifactType;
use sidekicks_contracts::repo::folders::RepoMountOrigin;
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::ComposedText;
use sidekicks_platforms::WallClock;
use sidekicks_provider::port::file_tool_write::{
    FileToolWriteClaim, FileToolWriteOpened, FileToolWriteOutcome, FileToolWritePort,
    FileToolWriteSettled,
};
use sidekicks_std::file::hashing_copy::copy_with_sha256;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_std::missing_entry::is_missing_entry;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::database::stored_column::text_column;
use sidekicks_store::events::session::appender::SessionEventAppender;
use sidekicks_workspace::folder::usage::{RepoFolderUsage, RepoFolderUsageError};
use sidekicks_workspace::git::worktree::occupancy::MountOccupancyReader;
use sidekicks_workspace::managed::write_watcher::{
    ManagedWorkspaceReport, ManagedWorkspaceWrite, ManagedWorkspaceWriteKind,
    ManagedWritesWatermark,
};
use tokio::sync::mpsc;

use crate::id::mint_artifact_id;
use crate::manifest_write::{
    ChatFolderPath, PublishedManifest, manifest_created_at, write_published_manifest,
};
use crate::payload_store::{ContentHash, PayloadStore};
use crate::publish::{SPOOL_FILE_MODE, new_spool_path, remove_spool};
use crate::refusals::ArtifactError;
use crate::validation::{
    SpooledPayload, Utf8Check, file_name_metadata, keep_leading_bytes, validate_and_store,
};

use self::tool_claims::{ClaimedVersion, claimed_version};

/// The media type a folder's manifest records.
const FOLDER_MEDIA_TYPE: &str = "inode/directory";

// The newest version's digest of a chat folder's path, or none for a path with no version yet.
const NEWEST_CONTENT_HASH_SQL: &str = "SELECT content_hash FROM artifact_manifests
  WHERE repo_mount_id = @repoMountId AND workspace_path = @workspacePath
  ORDER BY version_number DESC LIMIT 1";

// The managed mount of the chat folder its chat's id names.
const FOLDER_MOUNT_SQL: &str = "SELECT id FROM repo_mounts WHERE managed_session_id = @folderName";

// The managed mount of the chat folder its chat's id names, when the session holds it.
const HELD_FOLDER_MOUNT_SQL: &str = "SELECT mount.id FROM repo_mounts AS mount
  JOIN managed_folder_holds AS hold ON hold.repo_mount_id = mount.id
  WHERE mount.managed_session_id = @folderName AND hold.session_id = @sessionId";

/// A chat folder: its managed mount, and the chat whose id names it on disk.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct ChatFolder {
    repo_mount_id: RepoMountId,
    name: SessionId,
}

/// One path of one chat folder.
type WorkspacePath = (ChatFolder, ComposedText);

/// A file tool's call on a path, settled or still open, by the chat whose tool made it.
struct ToolCall {
    session_id: SessionId,
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
    /// A tool's claim rebuilt in the disk file's form.
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
    /// The chat folder's earliest live holder could not be read.
    #[error(transparent)]
    FolderUsage(#[from] RepoFolderUsageError),
}

/// Records a chat's writes as versions of its paths' artifacts.
pub struct ChatFileVersions {
    appender: Arc<SessionEventAppender>,
    reads: Arc<DatabaseReadPool>,
    folder_usage: RepoFolderUsage,
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
    /// Versions of the writes in the chat folders under `workspaces_folder`, appended through
    /// `appender`, read through `reads` (a folder's holders among them), stored into `payloads`
    /// and spooled in `spool_folder`, which must be on the store's volume; each caught-up instant
    /// is stored through `watermark`.
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
            folder_usage: RepoFolderUsage::new(
                Arc::clone(&reads),
                MountOccupancyReader::new(Arc::clone(&reads)),
            ),
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

    /// Records the watch's report of `write`, whose session names its chat folder, as its path's
    /// next version on the folder's earliest live holder, or holds it while a file tool's call on
    /// the path is open; a folder no mount names any more records nothing. Fails as the folder's
    /// reads or the version's write fail.
    pub(crate) async fn take_reported_write(
        &self,
        write: ManagedWorkspaceWrite,
    ) -> Result<(), ChatFileVersionError> {
        let Some(path) = workspace_path_text(&write.relative_path) else {
            return Ok(());
        };
        let Some(repo_mount_id) = self.read_folder_mount(write.session_id, None).await? else {
            return Ok(());
        };
        let folder = ChatFolder {
            repo_mount_id,
            name: write.session_id,
        };
        let key = (folder, path);
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
        let holder = self.earliest_live_holder(folder).await?;
        Ok(self
            .record_version(&key, holder, PathWrite::OnDisk(write.kind))
            .await?)
    }

    // Holds the watch's reports of the call's path until the call settles.
    async fn open_call(&self, opened: FileToolWriteOpened) -> Result<(), ChatFileVersionError> {
        let Some(key) = self
            .workspace_path_of(opened.session_id, &opened.path)
            .await?
        else {
            return Ok(());
        };
        self.lock_held_writes()
            .paths
            .entry(key)
            .or_default()
            .calls
            .push_back(ToolCall {
                session_id: opened.session_id,
                call_id: opened.call_id,
                outcome: None,
            });
        Ok(())
    }

    // Records the call's outcome and every settled call ahead of the path's first open one, in the
    // order they opened, then a report that waited once none is open, and then a caught-up instant
    // that waited for that report, recorded or not.
    async fn settle_call(&self, settled: FileToolWriteSettled) -> Result<(), ChatFileVersionError> {
        let Some(key) = self
            .workspace_path_of(settled.session_id, &settled.path)
            .await?
        else {
            return Ok(());
        };
        let _path_hold = self.path_lock.acquire(key.clone()).await;
        let (outcomes, is_call_still_held, is_report_due) = {
            let mut guard = self.lock_held_writes();
            let held_paths = &mut guard.paths;
            let call = held_paths
                .get_mut(&key)
                .and_then(|held| {
                    held.calls.iter_mut().find(|call| {
                        call.session_id == settled.session_id
                            && call.call_id == settled.call_id
                            && call.outcome.is_none()
                    })
                })
                .ok_or_else(|| ChatFileVersionError::CallNotOpen {
                    call_id: settled.call_id.clone(),
                })?;
            call.outcome = Some(settled.outcome);
            let held = held_paths
                .get_mut(&key)
                .expect("the settled call's path is held");
            let mut outcomes = Vec::new();
            while let Some(call) = held.calls.pop_front() {
                let Some(outcome) = call.outcome else {
                    held.calls.push_front(call);
                    break;
                };
                outcomes.push((call.session_id, outcome));
            }
            let is_call_still_held = !held.calls.is_empty();
            let is_report_due = !is_call_still_held && held.is_report_waiting;
            if !is_call_still_held {
                held_paths.remove(&key);
            }
            (outcomes, is_call_still_held, is_report_due)
        };
        let recorded = self
            .record_settled(&key, outcomes, is_call_still_held, is_report_due)
            .await;
        if is_report_due {
            self.finish_due_report().await;
        }
        recorded
    }

    // Records the settled calls' claims in order, each on its call's chat, then the path's disk on
    // the folder's earliest live holder when `is_report_due`. A claim the disk does not hold is
    // kept in the disk's form only when a later call on the path explains the difference: a later
    // one in `outcomes`, or one still held when `is_call_still_held`.
    async fn record_settled(
        &self,
        key: &WorkspacePath,
        outcomes: Vec<(SessionId, FileToolWriteOutcome)>,
        is_call_still_held: bool,
        is_report_due: bool,
    ) -> Result<(), ChatFileVersionError> {
        let call_count = outcomes.len();
        for (index, (session_id, outcome)) in outcomes.into_iter().enumerate() {
            let FileToolWriteOutcome::Claimed(claim) = outcome else {
                continue;
            };
            let Some(claim) = self.resolve_claim(key, session_id, claim).await? else {
                continue;
            };
            let file_path = self.file_path_of(key);
            let is_explained = index + 1 < call_count || is_call_still_held;
            let claimed =
                tokio::task::spawn_blocking(move || claim.version_of(&file_path, is_explained))
                    .await
                    .map_err(ArtifactError::from)?
                    .map_err(ArtifactError::from)?;
            match claimed {
                ClaimedVersion::Disk => {
                    self.record_version(
                        key,
                        session_id,
                        PathWrite::OnDisk(ManagedWorkspaceWriteKind::File),
                    )
                    .await?;
                }
                ClaimedVersion::Rebuilt(bytes) => {
                    self.record_version(key, session_id, PathWrite::ToolResult(bytes.into()))
                        .await?;
                }
                ClaimedVersion::Nothing => {}
            }
        }
        if is_report_due {
            let holder = self.earliest_live_holder(key.0).await?;
            self.record_version(
                key,
                holder,
                PathWrite::OnDisk(ManagedWorkspaceWriteKind::File),
            )
            .await?;
        }
        Ok(())
    }

    // What `claim` by `session_id`'s tool on `key` is checked against the disk with: its text, or
    // its patch with the stored file of the newest version of its base, the file a move came from
    // or else `key`; none when the base lies outside every chat folder the chat holds or has no
    // version.
    async fn resolve_claim(
        &self,
        key: &WorkspacePath,
        session_id: SessionId,
        claim: FileToolWriteClaim,
    ) -> Result<Option<ResolvedClaim>, ArtifactError> {
        let (base_path, unified_diff) = match claim {
            FileToolWriteClaim::Text(text) => return Ok(Some(ResolvedClaim::Text(text))),
            FileToolWriteClaim::Patch {
                base_path,
                unified_diff,
            } => (base_path, unified_diff),
        };
        let base_key = match base_path {
            Some(base_path) => match self.workspace_path_of(session_id, &base_path).await? {
                Some(base_key) => base_key,
                None => return Ok(None),
            },
            None => key.clone(),
        };
        Ok(self
            .read_newest_content_hash(&base_key)
            .await?
            .map(|base_hash| ResolvedClaim::Patch {
                base_file: self.payloads.object_path_of(&base_hash),
                unified_diff,
            }))
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

    // Writes `write` as `key`'s next version on `session_id`, unless its bytes equal the newest
    // one's, it is a folder already kept, or its file is gone.
    async fn record_version(
        &self,
        key: &WorkspacePath,
        session_id: SessionId,
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
                let file_path = self.file_path_of(key);
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
            session_id,
            run_id: None,
            created_by: None,
            client_idempotency_key: None,
            artifact_type: ArtifactType::File,
            content_hash: spooled.content_hash.clone(),
            size_bytes: spooled.size_bytes,
            media_type: String::new(),
            natural_size: None,
            metadata: file_name_metadata(key.1.as_str()),
            workspace_path: Some(ChatFolderPath {
                repo_mount_id: key.0.repo_mount_id,
                path: key.1.clone(),
            }),
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
        let (folder, path) = key.clone();
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok(connection
                    .prepare_cached(NEWEST_CONTENT_HASH_SQL)?
                    .query_row(
                        named_params! {
                            "@repoMountId": folder.repo_mount_id.text().as_str(),
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

    // The managed mount of the chat folder `folder_name` names, when one does and, with a
    // `holder`, that chat holds it.
    async fn read_folder_mount(
        &self,
        folder_name: SessionId,
        holder: Option<SessionId>,
    ) -> Result<Option<RepoMountId>, ArtifactError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                let folder_name = folder_name.text();
                let read_mount_id =
                    |row: &rusqlite::Row<'_>| text_column(row, 0, |text| RepoMountId::new(&text));
                let mount_id = match holder {
                    Some(holder) => connection.prepare_cached(HELD_FOLDER_MOUNT_SQL)?.query_row(
                        named_params! {
                            "@folderName": folder_name.as_str(),
                            "@sessionId": holder.text().as_str(),
                        },
                        read_mount_id,
                    ),
                    None => connection.prepare_cached(FOLDER_MOUNT_SQL)?.query_row(
                        named_params! { "@folderName": folder_name.as_str() },
                        read_mount_id,
                    ),
                };
                Ok(mount_id.optional()?)
            })
            .await
    }

    // The chat a write only the watch reports is recorded on: the folder's earliest live holder,
    // as the folder's origin names it.
    async fn earliest_live_holder(
        &self,
        folder: ChatFolder,
    ) -> Result<SessionId, ChatFileVersionError> {
        match self
            .folder_usage
            .read_usage(&folder.repo_mount_id)
            .await?
            .origin
        {
            RepoMountOrigin::Managed { session_id, .. } => Ok(session_id),
            RepoMountOrigin::Attached { .. } | RepoMountOrigin::Worktree { .. } => {
                unreachable!("a mount a chat folder's name finds is a managed mount")
            }
        }
    }

    // Where `key`'s file sits on disk.
    fn file_path_of(&self, key: &WorkspacePath) -> PathBuf {
        self.workspaces_folder
            .join(key.0.name.to_string())
            .join(key.1.as_str())
    }

    // The path `path` names in a chat folder the session holds, read from the folder's name, the
    // first part under the workspaces folder; none for a path in no folder it holds.
    async fn workspace_path_of(
        &self,
        session_id: SessionId,
        path: &Path,
    ) -> Result<Option<WorkspacePath>, ArtifactError> {
        let Ok(relative_path) = path.strip_prefix(&self.workspaces_folder) else {
            return Ok(None);
        };
        let mut components = relative_path.components();
        let Some(Component::Normal(folder_name)) = components.next() else {
            return Ok(None);
        };
        let Some(name) = folder_name
            .to_str()
            .and_then(|text| SessionId::new(text).ok())
        else {
            return Ok(None);
        };
        let Some(path) = workspace_path_text(components.as_path()) else {
            return Ok(None);
        };
        let Some(repo_mount_id) = self.read_folder_mount(name, Some(session_id)).await? else {
            return Ok(None);
        };
        Ok(Some((
            ChatFolder {
                repo_mount_id,
                name,
            },
            path,
        )))
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
        async move {
            self.open_call(opened)
                .await
                .map_err(|error| Box::new(error) as Box<dyn Error + Send + Sync>)
        }
        .boxed()
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

/// A claim ready to check against the disk, its patch's base found in the store.
enum ResolvedClaim {
    /// The file's whole text after the call.
    Text(String),
    /// A unified diff over the stored bytes at `base_file`.
    Patch {
        base_file: PathBuf,
        unified_diff: String,
    },
}

impl ResolvedClaim {
    /// The version this claim keeps of the file at `file_path`, as [`claimed_version`] finds it
    /// with `is_explained`; nothing from a patch that does not apply to its base, or a base that is
    /// not UTF-8. Fails as a read fails.
    fn version_of(self, file_path: &Path, is_explained: bool) -> io::Result<ClaimedVersion> {
        let text = match self {
            Self::Text(text) => text,
            Self::Patch {
                base_file,
                unified_diff,
            } => {
                let Ok(base) = String::from_utf8(std::fs::read(base_file)?) else {
                    return Ok(ClaimedVersion::Nothing);
                };
                // A diff that does not parse or apply claims nothing to check the disk against.
                let Some(patched) = diffy::Patch::from_str(&unified_diff)
                    .ok()
                    .and_then(|patch| diffy::apply(&base, &patch).ok())
                else {
                    return Ok(ClaimedVersion::Nothing);
                };
                patched.replace("\r\n", "\n")
            }
        };
        claimed_version(&text, file_path, is_explained)
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
    let mut utf8 = Utf8Check::default();
    let mut leading_bytes = Vec::new();
    let mut size_bytes: u64 = 0;
    let digest = copy_with_sha256(&mut source, &mut spool, |chunk| {
        utf8.feed(chunk);
        keep_leading_bytes(&mut leading_bytes, chunk);
        size_bytes += u64::try_from(chunk.len()).expect("a chunk's length fits a u64");
    })?;
    spool.sync_all()?;
    Ok(SpoolCopy {
        content_hash: ContentHash::of_sha256(&digest),
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

mod tool_claims;

#[cfg(test)]
mod tests;
