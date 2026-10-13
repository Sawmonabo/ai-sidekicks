//! The `artifact.*` methods. A client reads the list again on `artifact.published`, never on a
//! timer. A file reaches a session's artifacts through the three ingest calls; any other kind of
//! artifact a client holds whole is published in one call.

use crate::artifacts::ingest::{
    AttachmentIngestChunkRequest, AttachmentIngestChunkResponse, AttachmentIngestCompleteRequest,
    AttachmentIngestCompleteResponse, AttachmentIngestInitRequest, AttachmentIngestInitResponse,
};
use crate::artifacts::operations::{
    ArtifactListRequest, ArtifactListResponse, ArtifactReadRequest, ArtifactReadResponse,
};
use crate::artifacts::publication::{ArtifactPublishRequest, ArtifactPublishResponse};
use crate::method::methods;
use crate::typescript::TypeScriptModule;

methods! {
    /// The `artifact.*` methods, each with its checks.
    pub const ARTIFACT_METHOD_DESCRIPTORS = [
        /// Lists a session's artifacts.
        ArtifactList = query "artifact.list" {
            mutating: false,
            params: ArtifactListRequest,
            result: ArtifactListResponse,
            refusals: [],
        },
        /// Reads one artifact's manifest and as much of its payload as asked.
        ArtifactRead = query "artifact.read" {
            mutating: false,
            params: ArtifactReadRequest,
            result: ArtifactReadResponse,
            refusals: [ArtifactNotFound],
        },
        /// Opens an ingest stream for one file.
        ArtifactIngestInit = mutation "artifact.ingestInit" {
            mutating: true,
            params: AttachmentIngestInitRequest,
            result: AttachmentIngestInitResponse,
            refusals: [
                SessionNotFound,
                RunNotFound,
                ArtifactTooLarge,
                ArtifactIngestCapacityExhausted,
            ],
        },
        /// Sends one chunk of an open stream.
        ArtifactIngestChunk = mutation "artifact.ingestChunk" {
            mutating: true,
            params: AttachmentIngestChunkRequest,
            result: AttachmentIngestChunkResponse,
            refusals: [ArtifactIngestStreamInvalid, ArtifactTooLarge],
        },
        /// Completes a stream and commits its bytes as an artifact.
        ArtifactIngestComplete = mutation "artifact.ingestComplete" {
            mutating: true,
            params: AttachmentIngestCompleteRequest,
            result: AttachmentIngestCompleteResponse,
            refusals: [
                SessionNotFound,
                RunNotFound,
                ArtifactIngestStreamInvalid,
                ArtifactTypeUnreadable,
                ArtifactTypeCheckUnavailable,
            ],
        },
        /// Publishes one artifact from a payload the caller holds whole.
        ArtifactPublish = mutation "artifact.publish" {
            mutating: true,
            params: ArtifactPublishRequest,
            result: ArtifactPublishResponse,
            refusals: [
                SessionNotFound,
                RunNotFound,
                ArtifactFilePublishRefused,
                ArtifactIngestCapacityExhausted,
                ArtifactTooLarge,
                ArtifactTypeCheckUnavailable,
                ArtifactTypeUnreadable,
            ],
        },
    ];
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "artifacts/methods",
    doc: "The `artifact.*` methods. A client reads the list again on `artifact.published`, never \
          on a timer.",
    definitions: &[],
    constants: &[],
    method_tables: &[&ARTIFACT_METHOD_DESCRIPTORS],
};
