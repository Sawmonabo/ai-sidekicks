//! The three calls that stream a caller's file into a session's artifacts, request and reply:
//! open a stream, send its bytes in numbered chunks, and complete it. Every request member is a
//! caller's claim; the daemon derives the real media type and size from the bytes it spooled, and
//! those derived values are what the completion answers and what reach the manifest.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::artifacts::id::ArtifactId;
use crate::free_form_string::FILE_PATH_MAX_LEN;
use crate::run::id::RunId;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::attachment::Bytes;
use crate::wire::integer::SafeInt;
use crate::wire::text::{BoundedText, NonEmptyText};

ts_constants! {
    /// The most bytes one artifact chunk carries, either way: a chunk a caller streams in, and a
    /// byte range `artifact.read` answers.
    pub const ARTIFACT_CHUNK_MAX_BYTES: usize = 512 * 1024;
}

/// Opens an ingest stream for one file. `mediaType` is the caller's guess, absent when the file
/// declared none; it refuses nothing and is recorded nowhere, since the daemon reads the type from
/// the bytes. `declaredSizeBytes` also reserves the stream's spool space, so the stream's bytes
/// may not exceed it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AttachmentIngestInitRequest {
    /// The session the file is for.
    pub session_id: SessionId,
    /// The run the file is for; absent when no run asked for it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "RunId")]
    pub run_id: Option<RunId>,
    /// The file's name.
    pub file_name: BoundedText<1, FILE_PATH_MAX_LEN>,
    /// The caller's guess at the media type; never sent empty.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "NonEmptyText")]
    pub media_type: Option<NonEmptyText>,
    /// The size the caller declares, in bytes.
    pub declared_size_bytes: SafeInt<0>,
}

/// The opened stream: `ingestId` is a single-use handle, bound to the session and to the stream's
/// lifetime, that every chunk and the completion name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentIngestInitResponse {
    /// The stream's handle.
    pub ingest_id: NonEmptyText,
}

/// One chunk of an open stream. `sequenceNumber` counts from 0 with no gaps, and a resent chunk
/// carries the number it was first sent with; `chunk` is at most
/// [`ARTIFACT_CHUNK_MAX_BYTES`] bytes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AttachmentIngestChunkRequest {
    /// The stream's handle.
    pub ingest_id: NonEmptyText,
    /// The chunk's place in the stream, from 0.
    pub sequence_number: SafeInt<0>,
    /// The chunk's bytes.
    pub chunk: Bytes<0, ARTIFACT_CHUNK_MAX_BYTES>,
}

/// One chunk's acknowledgement. `receivedBytes` is the stream's running total after the chunk, so
/// progress is the daemon's count and never the sender's.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentIngestChunkResponse {
    /// The stream's handle.
    pub ingest_id: NonEmptyText,
    /// The bytes the stream has received so far.
    pub received_bytes: SafeInt<0>,
}

/// Completes a stream. The stream's handle is the only member: the daemon checks the spooled bytes
/// and commits them, and a resent completion answers with the first one's result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AttachmentIngestCompleteRequest {
    /// The stream's handle.
    pub ingest_id: NonEmptyText,
}

/// What the daemon committed. Every member is derived from the spooled bytes, never taken from the
/// opening request, so a caller that declared the wrong type or size learns what was recorded.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentIngestCompleteResponse {
    /// The artifact the file became.
    pub artifact_id: ArtifactId,
    /// The payload's SHA-256, the manifest's `digest`.
    pub content_hash: NonEmptyText,
    /// The file's name as stored.
    pub normalized_name: BoundedText<1, FILE_PATH_MAX_LEN>,
    /// The media type read from the bytes.
    pub derived_media_type: NonEmptyText,
    /// The size measured from the bytes.
    pub derived_size_bytes: SafeInt<0>,
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "artifacts/ingest",
    doc: "The three calls that stream a caller's file into a session's artifacts: open a stream, \
          send its bytes in numbered chunks, and complete it.",
    definitions: &[
        Definition::read::<AttachmentIngestInitRequest>().checked(),
        Definition::read::<AttachmentIngestInitResponse>().checked(),
        Definition::read::<AttachmentIngestChunkRequest>().checked(),
        Definition::read::<AttachmentIngestChunkResponse>().checked(),
        Definition::read::<AttachmentIngestCompleteRequest>().checked(),
        Definition::read::<AttachmentIngestCompleteResponse>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
