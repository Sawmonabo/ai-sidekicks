//! Publishing an artifact from a payload the caller holds whole, and the event payload that
//! announces an artifact was published or superseded.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::artifacts::id::ArtifactId;
use crate::artifacts::manifest::{ArtifactManifest, ArtifactState, ArtifactType, Extensible};
use crate::jsonrpc::framing::MAX_ONE_ATTACHMENT_BYTES;
use crate::run::id::RunId;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::attachment::Bytes;
use crate::wire::record::JsonRecord;
use crate::wire::text::NonEmptyText;

/// Publishes one artifact in a single call. The daemon hashes the payload's bytes, so the digest
/// and size are never the caller's to declare, and it reads the recorded type from the bytes. A
/// client's `file` is refused: a file comes in through ingest.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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

/// The published artifact's manifest: its id is the artifact id, its digest the content hash.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactPublishResponse {
    /// The manifest the daemon recorded.
    #[garde(dive)]
    pub manifest: ArtifactManifest,
}

/// The payload of `artifact.published` and `artifact.superseded`: it names the artifact and its
/// new state and carries no content. A member a newer daemon adds is kept in `rest`, so an older
/// reader keeps it rather than refusing a known event.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
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
    /// The artifact's new state.
    pub state: Extensible<ArtifactState>,
    /// Every member a newer daemon added, kept as received.
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "artifacts/publication",
    doc: "Publishing an artifact from a payload the caller holds whole, and the event payload \
          that announces an artifact was published or superseded.",
    definitions: &[
        Definition::read::<ArtifactPublishRequest>().checked(),
        Definition::read::<ArtifactPublishResponse>().checked(),
        Definition::read::<ArtifactPublicationPayload>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::ArtifactPublicationPayload;

    #[test]
    fn a_publication_keeps_every_member_and_state_a_newer_daemon_adds() {
        let written = json!({
            "sessionId": "550e8400-e29b-41d4-a716-446655440000",
            "artifactId": "0f2b4d5e-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "state": "archived",
            "addedByNewerDaemon": { "kept": true },
        });
        let payload: ArtifactPublicationPayload =
            serde_json::from_value(written.clone()).expect("a newer publication reads");
        let rewritten: Value = serde_json::to_value(&payload).expect("the publication writes");
        assert_eq!(rewritten, written);
    }
}
