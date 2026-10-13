//! The manifest the daemon keeps for every artifact in a session, and the two closed sets it
//! carries. A manifest keeps every member and value a newer daemon adds, so an older reader passes
//! them through instead of refusing the whole list.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::artifacts::id::ArtifactId;
use crate::run::id::RunId;
use crate::session::id::SessionId;
use crate::trust_statement::DeviceId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::record::JsonRecord;

/// The kind of an artifact: a file, a diff, a summary, a log, a design, or the output of one
/// workflow phase.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactType {
    /// A file.
    File,
    /// A diff.
    Diff,
    /// A summary.
    Summary,
    /// A log.
    Log,
    /// A design.
    Design,
    /// The output of one workflow phase.
    WorkflowOutput,
}

/// Where a manifest is in its life: written but not yet published, published, or replaced by a
/// later manifest.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactState {
    /// Written, not yet published.
    Pending,
    /// Published.
    Published,
    /// Replaced by a later manifest.
    Superseded,
}

/// A value of a closed set as this reader knows it, or one a newer daemon added, kept as its text
/// so a record read and written again loses nothing.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Extensible<T> {
    /// A value this reader knows.
    Known(T),
    /// A value a newer daemon added.
    Unknown(String),
}

impl<T: JsonSchema> JsonSchema for Extensible<T> {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        format!("Extensible{}", T::schema_name()).into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        json_schema!({ "anyOf": [generator.subschema_for::<T>(), { "type": "string" }] })
    }
}

/// One artifact as the daemon records it: `id` names the manifest and `digest` the content, so two
/// manifests can share one payload. `metadata` is the artifact's freeform provenance and holds its
/// file name and media type. A member a newer daemon adds is kept in `rest`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase")]
#[garde(allow_unvalidated)]
pub struct ArtifactManifest {
    /// The manifest's id.
    pub id: ArtifactId,
    /// The session the artifact belongs to.
    pub session_id: SessionId,
    /// The run that produced the artifact; absent when no run did.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "RunId")]
    pub run_id: Option<RunId>,
    /// The device the publishing request came from; absent when the daemon produced it itself.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "DeviceId")]
    pub created_by: Option<DeviceId>,
    /// The artifact's kind.
    pub artifact_type: Extensible<ArtifactType>,
    /// The payload's SHA-256 digest; a content-addressed manifest always has one.
    pub digest: String,
    /// The payload's length in bytes, measured by the daemon rather than declared by the caller.
    pub size: SafeInt<0>,
    /// Where the manifest is in its life.
    pub state: Extensible<ArtifactState>,
    /// The artifact's freeform provenance.
    pub metadata: JsonRecord,
    /// When the manifest was written.
    #[garde(dive)]
    pub created_at: WireInstant,
    /// Every member a newer daemon added, kept as received.
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "artifacts/manifest",
    doc: "The manifest the daemon keeps for every artifact in a session, and the two closed sets \
          it carries.",
    definitions: &[
        Definition::read::<ArtifactType>().checked(),
        Definition::read::<ArtifactState>().checked(),
        Definition::read::<ArtifactManifest>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::ArtifactManifest;

    #[test]
    fn a_manifest_keeps_every_member_and_value_a_newer_daemon_adds() {
        let written = json!({
            "id": "0f2b4d5e-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "sessionId": "550e8400-e29b-41d4-a716-446655440000",
            "artifactType": "storyboard",
            "digest": "sha256:00",
            "size": 11,
            "state": "archived",
            "metadata": { "mediaType": "text/plain" },
            "createdAt": "2026-01-01T14:20:00.000Z",
            "addedByNewerDaemon": { "kept": true },
        });
        let manifest: ArtifactManifest =
            serde_json::from_value(written.clone()).expect("a newer manifest reads");
        let rewritten: Value = serde_json::to_value(&manifest).expect("the manifest writes");
        assert_eq!(rewritten, written);
    }
}
