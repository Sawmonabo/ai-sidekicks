//! Takes a caller's file into a session's artifacts as a stream: a start that reserves the declared
//! size, numbered chunks spooled to a file outside the content store, and a completion that runs
//! the validation pipeline over the spool and writes the file's manifest and payload reference in
//! one transaction, the manifest first.
//!
//! - Starts pass the uploads' one admission, which client publishes share. A stream gives its place
//!   back when it ends or its completion commits. A start resent under its key answers the first
//!   stream while that stream is held.
//! - Every call on one stream runs alone, so an original and its resend never interleave. A resend
//!   of the last chunk is answered without appending it again, any other break in the sequence ends
//!   the stream, and a resent completion answers the first one's saved result while it is held.
//! - Each chunk is hashed, checked as UTF-8 and appended on the blocking pool as it lands, so the
//!   completion rereads nothing of the spool.
//! - Exclusions are taken in one order: a start's key, then the stream, then the admission ledger,
//!   then the content store's key. The reaper snapshots under the ledger, lets it go, then takes
//!   each stream's own.
//! - The registry is in memory and bounded: the open streams by the admission, the completed ones
//!   by their lifetime and a count, past which the oldest is let go. A stream dies with the daemon,
//!   and its spool is reaped once unwritten for long enough.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::SystemTime;

use bytes::Bytes as ByteBuffer;
use sha2::{Digest as _, Sha256};
use sidekicks_contracts::artifacts::ingest::{
    ArtifactIngestCompleteRequest, ArtifactIngestCompleteResponse, ArtifactIngestStartRequest,
    ArtifactIngestStartResponse, ArtifactIngestWriteRequest, ArtifactIngestWriteResponse,
};
use sidekicks_contracts::artifacts::manifest::ArtifactType;
use sidekicks_contracts::artifacts::operations::IngestStreamInvalidReason;
use sidekicks_contracts::free_form_string::FILE_PATH_MAX_LEN;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::AnyValue;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::record::JsonRecord;
use sidekicks_contracts::wire::text::{BoundedText, NonEmptyText};
use sidekicks_platforms::WallClock;
use tokio::task::JoinError;

use crate::artifacts::admission::{AdmittedUpload, UploadAdmission};
use crate::artifacts::id::mint_artifact_id;
use crate::artifacts::ingest::limits::{
    ABANDONED_SPOOL_TTL, MAX_HELD_COMPLETIONS, MAX_INGEST_STREAM_LIFETIME,
};
use crate::artifacts::manifest_write::{
    PublishedManifest, check_artifact_owner, manifest_created_at, write_published_manifest,
};
use crate::artifacts::payload_store::{ContentHash, PayloadStore};
use crate::artifacts::refusals::{
    ArtifactError, artifact_too_large_past_declared, ingest_start_idempotency_conflict,
    ingest_stream_invalid,
};
use crate::artifacts::validation::{
    FILE_NAME_MEMBER, SpooledPayload, Utf8Check, keep_leading_bytes, normalize_file_name,
    validate_and_store,
};
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::events::session::appender::SessionEventAppender;
use crate::keyed_lock::KeyedLock;
use crate::missing_entry::MissingEntry as _;
#[cfg(test)]
use crate::pause_point::PausePoint;
use crate::settle_all::{SettleFailures, settle_all};
use sidekicks_contracts::wire::id::mint_uuid_v7;

// The mode of a spool file: its owner's alone.
const SPOOL_FILE_MODE: u32 = 0o600;

/// A start's key within its session.
type StartKey = (SessionId, ClientUuid);

/// What a start asked for, kept beside its key so a resend can be told from another request.
struct StartRecord {
    ingest_id: String,
    run_id: Option<RunId>,
    file_name: BoundedText<1, FILE_PATH_MAX_LEN>,
    declared_size_bytes: SafeInt<0>,
}

/// What a stream has written so far; taken out while a chunk is written on the blocking pool.
struct StreamProgress {
    content_hash: Sha256,
    utf8: Utf8Check,
    leading_bytes: Vec<u8>,
    next_sequence_number: u64,
    received_bytes: u64,
    /// The SHA-256 of the last chunk appended, which a resend is compared against.
    last_chunk_digest: Option<[u8; 32]>,
}

/// A stream taking chunks.
struct OpenStream {
    start_key: StartKey,
    session_id: SessionId,
    run_id: Option<RunId>,
    /// The caller's name, normalized: what the manifest keeps and a refusal names.
    file_name: BoundedText<1, FILE_PATH_MAX_LEN>,
    /// The type the caller declared, kept only for UTF-8 text whose signature names no type.
    declared_media_type: Option<String>,
    declared_size_bytes: u64,
    /// The stream's place among the open uploads and the room it has yet to write.
    upload: AdmittedUpload,
    opened_at: SystemTime,
    spool_path: PathBuf,
    /// `None` while a call holding the stream writes a chunk, and for good once such a call was
    /// dropped before it put the progress back.
    progress: Option<StreamProgress>,
}

/// A stream whose completion committed, held only to answer a resent completion.
struct CompletedStream {
    start_key: StartKey,
    opened_at: SystemTime,
    response: ArtifactIngestCompleteResponse,
    /// The digest the completion committed, which its saved result must still name.
    committed_content_hash: ContentHash,
}

/// One stream in the registry.
enum IngestStream {
    /// Taking chunks.
    Open(Box<OpenStream>),
    /// Completed, held to answer a resent completion.
    Completed(CompletedStream),
}

impl IngestStream {
    fn opened_at(&self) -> SystemTime {
        match self {
            Self::Open(stream) => stream.opened_at,
            Self::Completed(stream) => stream.opened_at,
        }
    }

    fn start_key(&self) -> &StartKey {
        match self {
            Self::Open(stream) => &stream.start_key,
            Self::Completed(stream) => &stream.start_key,
        }
    }
}

/// The streams of every session, their start keys, and the completed ones oldest first.
#[derive(Default)]
struct Registry {
    streams: HashMap<String, IngestStream>,
    start_keys: HashMap<StartKey, StartRecord>,
    completed_ids: VecDeque<String>,
}

impl Registry {
    // Forgets the stream, and its start key with it.
    fn remove(&mut self, ingest_id: &str) -> Option<IngestStream> {
        let stream = self.streams.remove(ingest_id)?;
        self.start_keys.remove(stream.start_key());
        Some(stream)
    }
}

/// Why a call finds no stream to go on with.
enum StreamGone {
    /// The id names no stream the registry holds.
    Unknown,
    /// The stream outlived its lifetime.
    Expired,
    /// A write on the stream was dropped mid-chunk, so what its spool holds is unknown.
    WriteDropped,
}

/// What writing one chunk came to, decided where the chunk was hashed.
enum ChunkOutcome {
    /// The chunk was appended.
    Appended,
    /// The last chunk sent again with the same bytes; nothing was appended.
    ResentLast,
    /// The chunk broke the sequence.
    SequenceBroken,
    /// The chunk would take the stream past its declared size.
    PastDeclared,
    /// The spool could not be written.
    Failed(io::Error),
}

/// The ingest streams of every session, and the reaper pass that ends the abandoned ones.
pub(crate) struct ArtifactIngestService {
    appender: Arc<SessionEventAppender>,
    reads: Arc<DatabaseReadPool>,
    payloads: Arc<PayloadStore>,
    admission: Arc<UploadAdmission>,
    clock: Arc<dyn WallClock>,
    registry: Mutex<Registry>,
    stream_lock: KeyedLock<String>,
    start_key_lock: KeyedLock<StartKey>,
    /// Where a test holds a write inside its stream's exclusion.
    #[cfg(test)]
    pause: PausePoint,
}

impl ArtifactIngestService {
    /// A service appending through `appender`, reading through `reads`, storing into `payloads`
    /// and spooling in `admission`'s folder, which must be on the store's volume.
    pub(crate) fn new(
        appender: Arc<SessionEventAppender>,
        reads: Arc<DatabaseReadPool>,
        payloads: Arc<PayloadStore>,
        admission: Arc<UploadAdmission>,
        clock: Arc<dyn WallClock>,
    ) -> Self {
        Self {
            appender,
            reads,
            payloads,
            admission,
            clock,
            registry: Mutex::default(),
            stream_lock: KeyedLock::new(),
            start_key_lock: KeyedLock::new(),
            #[cfg(test)]
            pause: PausePoint::default(),
        }
    }

    /// Opens a stream for one file, reserving its declared size; a start resent under its key
    /// answers the first stream while it is held. Fails with `session.notFound`, with
    /// `agent.run.notFound` for a run that is not the session's, with
    /// `artifact.idempotencyConflict` for a key reused with another run, name or size, and with
    /// the admission's refusals, `artifact.tooLarge` and `artifact.ingest.capacityExhausted`; a
    /// refusal opens nothing.
    pub(crate) async fn start(
        &self,
        request: ArtifactIngestStartRequest,
    ) -> Result<ArtifactIngestStartResponse, ArtifactError> {
        check_artifact_owner(&self.reads, request.session_id, request.run_id).await?;
        let start_key = (request.session_id, request.client_idempotency_key.clone());
        let _start_hold = self.start_key_lock.acquire(start_key.clone()).await;
        if let Some(record) = self.lock_registry().start_keys.get(&start_key) {
            let is_same_request = record.run_id == request.run_id
                && record.file_name == request.file_name
                && record.declared_size_bytes == request.declared_size_bytes;
            return if is_same_request {
                Ok(ArtifactIngestStartResponse {
                    ingest_id: ingest_id_text(&record.ingest_id),
                })
            } else {
                Err(ingest_start_idempotency_conflict(&record.ingest_id).into())
            };
        }
        let file_name = normalize_file_name(request.file_name.as_str());
        let declared_size_bytes = request.declared_size_bytes.get();
        let upload = self
            .admission
            .admit(declared_size_bytes, Some(file_name.as_str()))
            .await?;
        let ingest_id = mint_uuid_v7().to_string();
        let spool_path = self.admission.spool_folder().join(&ingest_id);
        let created_path = spool_path.clone();
        tokio::task::spawn_blocking(move || {
            sidekicks_platforms::create_new_file(&created_path, SPOOL_FILE_MODE).map(drop)
        })
        .await??;
        let mut registry = self.lock_registry();
        registry.start_keys.insert(
            start_key.clone(),
            StartRecord {
                ingest_id: ingest_id.clone(),
                run_id: request.run_id,
                file_name: request.file_name,
                declared_size_bytes: request.declared_size_bytes,
            },
        );
        registry.streams.insert(
            ingest_id.clone(),
            IngestStream::Open(Box::new(OpenStream {
                start_key,
                session_id: request.session_id,
                run_id: request.run_id,
                file_name,
                declared_media_type: request
                    .media_type
                    .map(|media_type| media_type.as_str().to_owned()),
                declared_size_bytes,
                upload,
                opened_at: self.clock.now(),
                spool_path,
                progress: Some(StreamProgress {
                    content_hash: Sha256::new(),
                    utf8: Utf8Check::default(),
                    leading_bytes: Vec::new(),
                    next_sequence_number: 0,
                    received_bytes: 0,
                    last_chunk_digest: None,
                }),
            })),
        );
        Ok(ArtifactIngestStartResponse {
            ingest_id: ingest_id_text(&ingest_id),
        })
    }

    /// Appends one chunk to its stream's spool and answers the stream's running total of bytes; a
    /// resend of the last chunk is answered without appending it again. Fails with
    /// `artifact.ingest.streamInvalid` for a stream that is unknown, completed or past its
    /// lifetime, or for a chunk out of sequence, which ends the stream; with `artifact.tooLarge`
    /// for a chunk past the declared size, which ends it too; and as
    /// [`ArtifactError::StreamWriteDropped`], ending the stream, after a write dropped mid-chunk.
    pub(crate) async fn write(
        &self,
        request: ArtifactIngestWriteRequest,
    ) -> Result<ArtifactIngestWriteResponse, ArtifactError> {
        let ingest_id = request.ingest_id.as_str().to_owned();
        let _stream_hold = self.stream_lock.acquire(ingest_id.clone()).await;
        let taken = {
            let mut registry = self.lock_registry();
            match self.held_stream(&mut registry, &ingest_id) {
                Err(gone) => Err(gone),
                Ok(IngestStream::Completed(_)) => {
                    return Err(ingest_stream_invalid(
                        &ingest_id,
                        IngestStreamInvalidReason::AlreadyCompleted,
                    )
                    .into());
                }
                Ok(IngestStream::Open(stream)) => match stream.progress.take() {
                    Some(progress) => Ok((
                        progress,
                        stream.spool_path.clone(),
                        stream.declared_size_bytes,
                        stream.file_name.clone(),
                    )),
                    None => Err(StreamGone::WriteDropped),
                },
            }
        };
        let (progress, spool_path, declared_size_bytes, file_name) = match taken {
            Ok(taken) => taken,
            Err(gone) => return Err(self.refuse_gone(&ingest_id, gone).await),
        };
        #[cfg(test)]
        self.pause.pass().await;
        let sequence_number = request.sequence_number.get();
        let chunk = request.chunk.into_bytes();
        let written = tokio::task::spawn_blocking(move || {
            write_chunk(
                progress,
                &spool_path,
                declared_size_bytes,
                sequence_number,
                &chunk,
            )
        })
        .await;
        let (progress, outcome) = match written {
            Ok(written) => written,
            Err(interrupted) => return Err(self.end_with(&ingest_id, interrupted.into()).await),
        };
        let received_bytes = progress.received_bytes;
        if let Some(IngestStream::Open(stream)) = self.lock_registry().streams.get_mut(&ingest_id) {
            stream
                .upload
                .set_remaining_bytes(stream.declared_size_bytes - received_bytes);
            stream.progress = Some(progress);
        }
        let failure: ArtifactError = match outcome {
            ChunkOutcome::Appended | ChunkOutcome::ResentLast => {
                return Ok(ArtifactIngestWriteResponse {
                    ingest_id: request.ingest_id,
                    received_bytes: SafeInt::new(received_bytes)
                        .expect("a stream holds no more than its declared safe size"),
                });
            }
            ChunkOutcome::SequenceBroken => {
                ingest_stream_invalid(&ingest_id, IngestStreamInvalidReason::SequenceBroken).into()
            }
            ChunkOutcome::PastDeclared => {
                artifact_too_large_past_declared(file_name.as_str(), declared_size_bytes).into()
            }
            ChunkOutcome::Failed(failure) => failure.into(),
        };
        Err(self.end_with(&ingest_id, failure).await)
    }

    /// Completes a stream: runs the pipeline over its spool, then writes the file's manifest,
    /// attributed to `created_by`, and its payload reference. A resent completion answers the
    /// first one's saved result while it is held. Fails with `artifact.ingest.streamInvalid` for a
    /// stream that is unknown or past its lifetime, or whose saved result no longer names the
    /// digest it committed, with `session.notFound` once its session is gone and
    /// `agent.run.notFound` for a run that is not the session's, and as
    /// [`ArtifactError::StreamWriteDropped`] after a write dropped mid-chunk; every failure ends
    /// the stream.
    pub(crate) async fn complete(
        &self,
        request: ArtifactIngestCompleteRequest,
        created_by: DeviceId,
    ) -> Result<ArtifactIngestCompleteResponse, ArtifactError> {
        let ingest_id = request.ingest_id.as_str().to_owned();
        let _stream_hold = self.stream_lock.acquire(ingest_id.clone()).await;
        let completing = {
            let mut registry = self.lock_registry();
            match self.held_stream(&mut registry, &ingest_id) {
                Err(gone) => Err(gone),
                Ok(IngestStream::Completed(stream)) => {
                    if stream.response.content_hash.as_str()
                        == stream.committed_content_hash.as_str()
                    {
                        return Ok(stream.response.clone());
                    }
                    Ok(None)
                }
                Ok(IngestStream::Open(stream)) => match stream.progress.as_ref() {
                    None => Err(StreamGone::WriteDropped),
                    Some(progress) => {
                        let content_hash =
                            ContentHash::of_sha256(&progress.content_hash.clone().finalize());
                        Ok(Some((
                            PublishedManifest {
                                artifact_id: mint_artifact_id(),
                                session_id: stream.session_id,
                                run_id: stream.run_id,
                                created_by: Some(created_by),
                                client_idempotency_key: None,
                                artifact_type: ArtifactType::File,
                                content_hash: content_hash.clone(),
                                size_bytes: SafeInt::new(progress.received_bytes)
                                    .expect("a stream holds no more than its declared safe size"),
                                media_type: String::new(),
                                natural_size: None,
                                metadata: file_name_metadata(&stream.file_name),
                                workspace_path: None,
                                plan_id: None,
                                created_at: manifest_created_at(self.clock.as_ref()),
                            },
                            SpooledPayload {
                                spool_path: stream.spool_path.clone(),
                                content_hash,
                                leading_bytes: progress.leading_bytes.clone(),
                                is_utf8: progress.utf8.is_utf8(),
                                declared_media_type: stream.declared_media_type.clone(),
                            },
                            stream.file_name.clone(),
                        )))
                    }
                },
            }
        };
        let completing = match completing {
            Ok(completing) => completing,
            Err(gone) => return Err(self.refuse_gone(&ingest_id, gone).await),
        };
        let Some((manifest, payload, file_name)) = completing else {
            let mismatch = ingest_stream_invalid(
                &ingest_id,
                IngestStreamInvalidReason::CompletionRecordMismatch,
            );
            return Err(self.end_with(&ingest_id, mismatch.into()).await);
        };
        let artifact_id = manifest.artifact_id;
        let content_hash = manifest.content_hash.clone();
        let size_bytes = manifest.size_bytes;
        let stored = validate_and_store(&self.payloads, payload, |reading| {
            write_published_manifest(
                &self.appender,
                PublishedManifest {
                    media_type: reading.media_type,
                    natural_size: reading.natural_size,
                    ..manifest
                },
            )
        })
        .await;
        let admitted = match stored {
            Ok(admitted) => admitted,
            Err(failure) => return Err(self.end_with(&ingest_id, failure).await),
        };
        let response = ArtifactIngestCompleteResponse {
            artifact_id,
            content_hash: NonEmptyText::new(content_hash.to_string())
                .expect("a content hash is never empty"),
            normalized_name: file_name,
            derived_media_type: NonEmptyText::new(admitted.derived_media_type)
                .expect("a derived media type is never empty"),
            derived_size_bytes: size_bytes,
        };
        let mut registry = self.lock_registry();
        if let Some(IngestStream::Open(stream)) = registry.streams.remove(&ingest_id) {
            // Dropping the open stream gives its place and reservation back.
            registry.streams.insert(
                ingest_id.clone(),
                IngestStream::Completed(CompletedStream {
                    start_key: stream.start_key,
                    opened_at: stream.opened_at,
                    response: response.clone(),
                    committed_content_hash: content_hash,
                }),
            );
            hold_completed(&mut registry, ingest_id);
        }
        Ok(response)
    }

    /// One pass of the reaper: ends every stream past its lifetime, open or completed, releasing
    /// what it held, and deletes every spool no stream holds that has gone unwritten past its time
    /// to live. Fails with the one failure, or every failure together, once the rest are done.
    pub(crate) async fn reap(&self) -> Result<(), SettleFailures<ArtifactError>> {
        let expired_ids: Vec<String> = {
            let _ledger_hold = self.admission.hold_still().await;
            let now = self.clock.now();
            self.lock_registry()
                .streams
                .iter()
                .filter(|(_, stream)| is_past_lifetime(now, stream.opened_at()))
                .map(|(ingest_id, _)| ingest_id.clone())
                .collect()
        };
        let mut outcomes = Vec::with_capacity(expired_ids.len() + 1);
        for ingest_id in expired_ids {
            let _stream_hold = self.stream_lock.acquire(ingest_id.clone()).await;
            // A call holding the stream may have ended it while this pass waited.
            let removed = {
                let mut registry = self.lock_registry();
                let is_expired = registry
                    .streams
                    .get(&ingest_id)
                    .is_some_and(|stream| is_past_lifetime(self.clock.now(), stream.opened_at()));
                if is_expired {
                    registry.remove(&ingest_id)
                } else {
                    None
                }
            };
            if let Some(stream) = removed {
                outcomes.push(delete_spool_of(stream).await.map_err(ArtifactError::Disk));
            }
        }
        match self.reap_abandoned_spools().await {
            Ok(failures) => {
                outcomes.extend(failures.into_iter().map(|failure| Err(failure.into())));
            }
            Err(interrupted) => outcomes.push(Err(interrupted.into())),
        }
        settle_all(outcomes, "reaping the ingest streams").map(drop)
    }

    // The stream `ingest_id` names, or why there is none to go on with.
    fn held_stream<'registry>(
        &self,
        registry: &'registry mut Registry,
        ingest_id: &str,
    ) -> Result<&'registry mut IngestStream, StreamGone> {
        let stream = registry
            .streams
            .get_mut(ingest_id)
            .ok_or(StreamGone::Unknown)?;
        if is_past_lifetime(self.clock.now(), stream.opened_at()) {
            return Err(StreamGone::Expired);
        }
        Ok(stream)
    }

    // The failure for a stream that is gone, ending one past its lifetime or whose state was lost
    // first.
    async fn refuse_gone(&self, ingest_id: &str, gone: StreamGone) -> ArtifactError {
        match gone {
            StreamGone::Unknown => {
                ingest_stream_invalid(ingest_id, IngestStreamInvalidReason::UnknownStream).into()
            }
            StreamGone::Expired => {
                let expired =
                    ingest_stream_invalid(ingest_id, IngestStreamInvalidReason::LifetimeExpired);
                self.end_with(ingest_id, expired.into()).await
            }
            StreamGone::WriteDropped => {
                self.end_with(ingest_id, ArtifactError::StreamWriteDropped)
                    .await
            }
        }
    }

    // Ends the stream, which releases its place and reservation and deletes its spool, and
    // answers `failure` with any failure of that deletion beside it.
    async fn end_with(&self, ingest_id: &str, failure: ArtifactError) -> ArtifactError {
        let removed = self.lock_registry().remove(ingest_id);
        let Some(stream) = removed else {
            return failure;
        };
        let cleanup_failures = delete_spool_of(stream).await.err().into_iter().collect();
        failure.with_cleanup_failures(cleanup_failures, "ending the ingest stream")
    }

    // Deletes every spool no stream holds that has gone unwritten past its time to live, and
    // answers each failure it met.
    async fn reap_abandoned_spools(&self) -> Result<Vec<io::Error>, JoinError> {
        let held_ids: HashSet<String> = self.lock_registry().streams.keys().cloned().collect();
        let spool_folder = self.admission.spool_folder().to_owned();
        let Some(reap_before) = self.clock.now().checked_sub(ABANDONED_SPOOL_TTL) else {
            return Ok(Vec::new());
        };
        tokio::task::spawn_blocking(move || {
            remove_abandoned_spools(&spool_folder, &held_ids, reap_before)
        })
        .await
    }

    fn lock_registry(&self) -> MutexGuard<'_, Registry> {
        // Each change to the registry is one insert or removal, which no panic leaves half done.
        self.registry.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

// Decides what one chunk does to its stream and, when it extends it, appends, hashes and checks it.
fn write_chunk(
    mut progress: StreamProgress,
    spool_path: &Path,
    declared_size_bytes: u64,
    sequence_number: u64,
    chunk: &ByteBuffer,
) -> (StreamProgress, ChunkOutcome) {
    let chunk_digest: [u8; 32] = Sha256::digest(chunk).into();
    let is_resend_of_last = progress.next_sequence_number.checked_sub(1) == Some(sequence_number)
        && progress.last_chunk_digest == Some(chunk_digest);
    if is_resend_of_last {
        return (progress, ChunkOutcome::ResentLast);
    }
    if sequence_number != progress.next_sequence_number {
        return (progress, ChunkOutcome::SequenceBroken);
    }
    let chunk_bytes = u64::try_from(chunk.len()).expect("a chunk's length fits in u64");
    if progress.received_bytes + chunk_bytes > declared_size_bytes {
        return (progress, ChunkOutcome::PastDeclared);
    }
    let appended = std::fs::OpenOptions::new()
        .append(true)
        .open(spool_path)
        .and_then(|mut spool| spool.write_all(chunk));
    if let Err(failure) = appended {
        return (progress, ChunkOutcome::Failed(failure));
    }
    progress.content_hash.update(chunk);
    progress.utf8.feed(chunk);
    keep_leading_bytes(&mut progress.leading_bytes, chunk);
    progress.received_bytes += chunk_bytes;
    progress.next_sequence_number += 1;
    progress.last_chunk_digest = Some(chunk_digest);
    (progress, ChunkOutcome::Appended)
}

// Whether a stream opened at `opened_at` has outlived its lifetime at `now`; a clock set back
// keeps it alive.
fn is_past_lifetime(now: SystemTime, opened_at: SystemTime) -> bool {
    now.duration_since(opened_at)
        .is_ok_and(|age| age > MAX_INGEST_STREAM_LIFETIME)
}

// Notes a completed stream, letting the oldest completed one go past the count held.
fn hold_completed(registry: &mut Registry, ingest_id: String) {
    registry.completed_ids.push_back(ingest_id);
    if registry.completed_ids.len() <= MAX_HELD_COMPLETIONS {
        return;
    }
    let Some(oldest_id) = registry.completed_ids.pop_front() else {
        return;
    };
    // Gone already when the reaper or a call ended it; never an open stream, whose id is fresh.
    if matches!(
        registry.streams.get(&oldest_id),
        Some(IngestStream::Completed(_))
    ) {
        registry.remove(&oldest_id);
    }
}

// Deletes an ended stream's spool, once its place and reservation are given back.
async fn delete_spool_of(stream: IngestStream) -> Result<(), io::Error> {
    let spool_path = match stream {
        IngestStream::Open(stream) => stream.spool_path,
        IngestStream::Completed(_) => return Ok(()),
    };
    tokio::task::spawn_blocking(move || std::fs::remove_file(&spool_path).none_if_missing())
        .await
        .map_err(io::Error::other)?
        .map(drop)
}

// Removes each spool in `spool_folder` that `held_ids` does not name and that was last written
// before `reap_before`, and answers each failure; one its stream removed while this pass looked is
// skipped.
fn remove_abandoned_spools(
    spool_folder: &Path,
    held_ids: &HashSet<String>,
    reap_before: SystemTime,
) -> Vec<io::Error> {
    let entries = match std::fs::read_dir(spool_folder).none_if_missing() {
        Ok(Some(entries)) => entries,
        Ok(None) => return Vec::new(),
        Err(failure) => return vec![failure],
    };
    let mut failures = Vec::new();
    for entry in entries {
        let removal = entry.and_then(|entry| {
            if held_ids.contains(entry.file_name().to_string_lossy().as_ref())
                || entry.metadata()?.modified()? >= reap_before
            {
                return Ok(());
            }
            std::fs::remove_file(entry.path())
        });
        if let Err(failure) = removal.none_if_missing() {
            failures.push(failure);
        }
    }
    failures
}

// An ingest id as the wire carries it.
fn ingest_id_text(ingest_id: &str) -> NonEmptyText {
    NonEmptyText::new(ingest_id.to_owned()).expect("a minted ingest id is never empty")
}

// The metadata an ingested file's manifest keeps: its name.
fn file_name_metadata(file_name: &BoundedText<1, FILE_PATH_MAX_LEN>) -> JsonRecord {
    JsonRecord::new(
        [(
            FILE_NAME_MEMBER.to_owned(),
            AnyValue(serde_json::Value::String(file_name.as_str().to_owned())),
        )]
        .into(),
    )
    .expect("a file name member is no __proto__")
}

#[cfg(test)]
mod tests;
