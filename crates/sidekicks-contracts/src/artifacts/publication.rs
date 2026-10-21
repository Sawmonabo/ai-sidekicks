//! Publishing an artifact from a payload the caller holds whole, and the event payload that
//! announces an artifact was published.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::artifacts::id::ArtifactId;
use crate::artifacts::manifest::{ArtifactManifest, ArtifactType};
use crate::jsonrpc::framing::MAX_ONE_ATTACHMENT_BYTES;
use crate::method::KeyedRequest;
use crate::run::id::RunId;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::attachment::Bytes;
use crate::wire::id::ClientUuid;
use crate::wire::record::{JsonRecord, prototype_free, prototype_free_names};
use crate::wire::text::NonEmptyText;

/// Publishes one artifact in a single call. The daemon hashes the payload's bytes, so the digest
/// and size are never the caller's to declare, and it reads the recorded type from the bytes. A
/// client's `file` is refused: a file comes in through ingest. A resend under the same
/// `clientIdempotencyKey` answers the first publish's manifest, never a second artifact.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ArtifactPublishRequest {
    /// The session the artifact belongs to.
    pub session_id: SessionId,
    /// The run that produced it; absent when no run did.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "RunId")]
    pub run_id: Option<RunId>,
    /// The artifact's kind.
    pub artifact_type: ArtifactType,
    /// The payload's bytes.
    pub payload: Bytes<0, MAX_ONE_ATTACHMENT_BYTES>,
    /// The key that makes a resent publish one artifact.
    pub client_idempotency_key: ClientUuid,
    /// The caller's media type for the payload.
    pub media_type: NonEmptyText,
    /// The artifact's freeform provenance.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "JsonRecord")]
    pub metadata: Option<JsonRecord>,
}

impl KeyedRequest for ArtifactPublishRequest {}

/// The published artifact's manifest: its id is the artifact id, its digest the content hash.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactPublishResponse {
    /// The manifest the daemon recorded.
    #[garde(dive)]
    pub manifest: ArtifactManifest,
}

/// The payload of `artifact.published`: it names the artifact and carries no content; an artifact
/// is never changed in place, so a new version is a new artifact with its own event. A member a
/// newer daemon adds is kept in `rest`, so an older reader keeps it rather than refusing a known
/// event.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(extend("propertyNames" = prototype_free_names()))]
pub struct ArtifactPublicationPayload {
    /// The session the artifact belongs to.
    pub session_id: SessionId,
    /// The artifact.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ArtifactId")]
    pub artifact_id: Option<ArtifactId>,
    /// The run that produced it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "RunId")]
    pub run_id: Option<RunId>,
    /// The diff artifact that came with it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ArtifactId")]
    pub diff_artifact_id: Option<ArtifactId>,
    /// Every member a newer daemon added, kept as received; never `__proto__`.
    #[serde(flatten, deserialize_with = "prototype_free")]
    pub rest: Map<String, Value>,
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "artifacts/publication",
    doc: "Publishing an artifact from a payload the caller holds whole, and the event payload \
          that announces an artifact was published.",
    definitions: &[
        Definition::read::<ArtifactPublishRequest>().checked(),
        Definition::read::<ArtifactPublishResponse>().checked(),
        Definition::read::<ArtifactPublicationPayload>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};
