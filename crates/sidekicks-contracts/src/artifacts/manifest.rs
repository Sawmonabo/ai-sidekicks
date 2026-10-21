//! The manifest the daemon keeps for every artifact in a session, and the closed set of its kinds.
//! A manifest keeps every member and value a newer daemon adds, so an older reader passes them
//! through instead of refusing the whole list.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use strum::{IntoStaticStr, VariantArray};

use crate::artifacts::id::ArtifactId;
use crate::run::id::RunId;
use crate::session::id::SessionId;
use crate::trust_statement::DeviceId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::record::{JsonRecord, prototype_free, prototype_free_names};
use crate::wire::text::NonEmptyText;

/// The kind of an artifact: a file, a diff, a summary, a log, a design, or the output of one
/// workflow phase.
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    Hash,
    Serialize,
    Deserialize,
    JsonSchema,
    VariantArray,
    IntoStaticStr,
)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
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
#[schemars(extend("propertyNames" = prototype_free_names()))]
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
    pub digest: NonEmptyText,
    /// The payload's length in bytes, measured by the daemon rather than declared by the caller.
    pub size: SafeInt<0>,
    /// The artifact's freeform provenance.
    pub metadata: JsonRecord,
    /// When the manifest was written.
    #[garde(dive)]
    pub created_at: WireInstant,
    /// Every member a newer daemon added, kept as received; never `__proto__`.
    #[serde(flatten, deserialize_with = "prototype_free")]
    pub rest: Map<String, Value>,
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "artifacts/manifest",
    doc: "The manifest the daemon keeps for every artifact in a session, and the closed set of \
          its kinds.",
    definitions: &[
        Definition::read::<ArtifactType>().checked(),
        Definition::read::<ArtifactManifest>().checked(),
    ],
    constants: &[],
    method_tables: &[],
};

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde::Serialize;
    use serde::de::DeserializeOwned;
    use serde_json::{Value, json};

    use super::ArtifactManifest;
    use crate::artifacts::publication::ArtifactPublicationPayload;

    /// Reads `written` as `T` and writes it back, or `None` when it does not read.
    fn round_trip<T: DeserializeOwned + Serialize>(written: Value) -> Option<Value> {
        let read: T = serde_json::from_value(written).ok()?;
        Some(serde_json::to_value(&read).expect("a read value writes"))
    }

    #[rstest]
    #[case::manifest(
        json!({
            "id": "0f2b4d5e-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "sessionId": "550e8400-e29b-41d4-a716-446655440000",
            "artifactType": "storyboard",
            "digest": "sha256:00",
            "size": 11,
            "metadata": { "mediaType": "text/plain" },
            "createdAt": "2026-01-01T14:20:00.000Z",
            "addedByNewerDaemon": { "kept": true },
        }),
        round_trip::<ArtifactManifest>
    )]
    #[case::publication(
        json!({
            "sessionId": "550e8400-e29b-41d4-a716-446655440000",
            "artifactId": "0f2b4d5e-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "addedByNewerDaemon": { "kept": true },
        }),
        round_trip::<ArtifactPublicationPayload>
    )]
    fn an_artifact_keeps_every_member_and_value_a_newer_daemon_adds_but_a_prototype(
        #[case] written: Value,
        #[case] round_trip: fn(Value) -> Option<Value>,
    ) {
        assert_eq!(round_trip(written.clone()), Some(written.clone()));
        let mut with_prototype = written;
        with_prototype
            .as_object_mut()
            .expect("an artifact is an object")
            .insert("__proto__".to_owned(), json!({ "polluted": true }));
        assert_eq!(round_trip(with_prototype), None);
    }
}
