//! The `artifact.*` methods. A client reads the list again on `artifact.published`, never on a
//! timer. A file reaches a session's artifacts through the three ingest calls; any other kind of
//! artifact a client holds whole is published in one call.

use crate::artifacts::ingest::{
    ArtifactIngestCompleteRequest, ArtifactIngestCompleteResponse, ArtifactIngestStartRequest,
    ArtifactIngestStartResponse, ArtifactIngestWriteRequest, ArtifactIngestWriteResponse,
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
            refusals: [SessionNotFound],
        },
        /// Reads one artifact's manifest and as much of its payload as asked.
        ArtifactRead = query "artifact.read" {
            mutating: false,
            params: ArtifactReadRequest,
            result: ArtifactReadResponse,
            refusals: [ArtifactNotFound],
        },
        /// Opens an ingest stream for one file.
        ArtifactIngestStart = mutation "artifact.ingest.start" {
            mutating: true,
            params: ArtifactIngestStartRequest,
            result: ArtifactIngestStartResponse,
            refusals: [
                SessionNotFound,
                AgentRunNotFound,
                ArtifactTooLarge,
                ArtifactIngestCapacityExhausted,
            ],
        },
        /// Sends one chunk of an open stream.
        ArtifactIngestWrite = mutation "artifact.ingest.write" {
            mutating: true,
            params: ArtifactIngestWriteRequest,
            result: ArtifactIngestWriteResponse,
            refusals: [ArtifactIngestStreamInvalid, ArtifactTooLarge],
        },
        /// Completes a stream and commits its bytes as an artifact.
        ArtifactIngestComplete = mutation "artifact.ingest.complete" {
            mutating: true,
            params: ArtifactIngestCompleteRequest,
            result: ArtifactIngestCompleteResponse,
            refusals: [
                SessionNotFound,
                AgentRunNotFound,
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
                AgentRunNotFound,
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
