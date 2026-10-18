//! The artifact store's refusals, each sent on the wire by its code, and what an artifact call
//! fails with. A stream past its end is begun again from its opening, a full ledger is waited out
//! and sent again, and a file too large for its declaration or for the disk, a file sent to the
//! publish call and a key reused for another request are refused for good.

use std::io;

use serde_json::json;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::artifacts::operations::{
    ArtifactTooLargeReason, IngestStreamInvalidReason,
};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use tokio::task::JoinError;

use crate::cleanup_failures::CleanupFailures;
use crate::database::connection::read_pool::DatabaseReadError;
use crate::database::writer::WriteError;
use crate::ipc::domain_error::DomainError;

/// What an artifact call fails with: one of this module's refusals or another classified one, or
/// a fault inside the daemon.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ArtifactError {
    /// A refusal with its code.
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// A file or folder of the spool or the store could not be read or written.
    #[error("a file of the artifact store could not be read or written")]
    Disk(#[from] io::Error),
    /// A blocking task on the store's files ended before it finished.
    #[error("a task on the artifact store's files ended before it finished")]
    Interrupted(#[from] JoinError),
    /// An earlier write on the ingest stream was dropped mid-chunk, so the stream was ended.
    #[error("an earlier write on the ingest stream was dropped before it finished")]
    StreamWriteDropped,
    /// The write of a manifest was not kept.
    #[error(transparent)]
    Write(#[from] WriteError),
    /// A read of the artifact rows did not reach a connection.
    #[error(transparent)]
    Read(#[from] DatabaseReadError),
    /// SQLite refused a read, or a stored column does not read as its type.
    #[error("a read of the artifact rows failed")]
    Database(#[from] rusqlite::Error),
    /// A failure kept whole beside the failures of cleaning up after it.
    #[error(transparent)]
    WithCleanup(Box<CleanupFailures<ArtifactError, io::Error>>),
}

impl ArtifactError {
    /// `self` carrying `cleanup_failures`, or `self` alone when there are none. `operation` names
    /// what failed, as a log line says it.
    pub(crate) fn with_cleanup_failures(
        self,
        cleanup_failures: Vec<io::Error>,
        operation: &'static str,
    ) -> Self {
        if cleanup_failures.is_empty() {
            self
        } else {
            Self::WithCleanup(Box::new(CleanupFailures::new(
                self,
                cleanup_failures,
                operation,
            )))
        }
    }

    /// The refusal this failure is, or none for a fault.
    #[cfg(test)]
    pub(crate) fn refusal(&self) -> Option<&DomainError> {
        let Self::Refused(refusal) = self else {
            return None;
        };
        Some(refusal)
    }
}

/// `artifact.ingest.streamInvalid`: the call on `ingest_id` cannot proceed and cannot be retried
/// in place, so the caller begins again from a new stream.
pub(crate) fn ingest_stream_invalid(
    ingest_id: &str,
    reason: IngestStreamInvalidReason,
) -> DomainError {
    let reason_word = serde_json::to_value(reason).expect("a closed word writes as JSON");
    let reason_word = reason_word
        .as_str()
        .expect("a closed word writes as a JSON string");
    DomainError::new(
        format!("The ingest stream cannot go on: {reason_word}"),
        RefusalCode::ArtifactIngestStreamInvalid,
    )
    .with_detail(json!({ "ingestId": ingest_id, "reason": reason }))
}

/// `artifact.ingest.capacityExhausted`: no upload was admitted because the open uploads are at
/// their bound or the disk has no room for this one beside theirs. Nothing was created, so a later
/// one may admit.
pub(crate) fn ingest_capacity_exhausted() -> DomainError {
    DomainError::new(
        "The background service has no room for another upload right now",
        RefusalCode::ArtifactIngestCapacityExhausted,
    )
}

/// `artifact.tooLarge` for an upload declared larger than the `available_bytes` free on the disk
/// at admission, naming the file when there is one; a publish carries no file name.
pub(crate) fn artifact_too_large_for_volume(
    file_name: Option<&str>,
    available_bytes: u64,
) -> DomainError {
    let payload_name = file_name.unwrap_or("The payload");
    DomainError::new(
        format!("{payload_name} is larger than the {available_bytes} bytes free on the disk"),
        RefusalCode::ArtifactTooLarge,
    )
    .with_detail(match file_name {
        Some(file_name) => json!({
            "reason": ArtifactTooLargeReason::VolumeTooSmall,
            "fileName": file_name,
            "availableBytes": available_bytes,
        }),
        None => json!({
            "reason": ArtifactTooLargeReason::VolumeTooSmall,
            "availableBytes": available_bytes,
        }),
    })
}

/// `artifact.tooLarge` for a stream of `file_name` that sent more than the
/// `declared_size_bytes` it declared.
pub(crate) fn artifact_too_large_past_declared(
    file_name: &str,
    declared_size_bytes: u64,
) -> DomainError {
    DomainError::new(
        format!("{file_name} sent more than the {declared_size_bytes} bytes it declared"),
        RefusalCode::ArtifactTooLarge,
    )
    .with_detail(json!({
        "reason": ArtifactTooLargeReason::DeclaredSizeExceeded,
        "fileName": file_name,
        "declaredSizeBytes": declared_size_bytes,
    }))
}

/// `artifact.filePublishRefused`: a client published a file. A file reaches the store only through
/// the ingest calls, which are the one hardened way in for a file's bytes.
pub(crate) fn file_publish_refused() -> DomainError {
    DomainError::new(
        "A file is sent with artifact.ingest.start, not published",
        RefusalCode::ArtifactFilePublishRefused,
    )
}

/// `artifact.idempotencyConflict` for a publish whose key first published `artifact_id` from a
/// different request; that manifest is untouched.
pub(crate) fn publish_idempotency_conflict(artifact_id: ArtifactId) -> DomainError {
    DomainError::new(
        "This publish's key already published a different artifact",
        RefusalCode::ArtifactIdempotencyConflict,
    )
    .with_detail(json!({ "artifactId": artifact_id }))
}

/// `artifact.idempotencyConflict` for an opening whose key first opened `ingest_id` from a
/// different request; that stream is untouched.
pub(crate) fn ingest_start_idempotency_conflict(ingest_id: &str) -> DomainError {
    DomainError::new(
        "This opening's key already opened a stream for a different file",
        RefusalCode::ArtifactIdempotencyConflict,
    )
    .with_detail(json!({ "ingestId": ingest_id }))
}
