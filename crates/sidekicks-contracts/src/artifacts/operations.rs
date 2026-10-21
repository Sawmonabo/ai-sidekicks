//! Listing a session's artifacts and reading one of them, and the refusal codes the artifact
//! calls answer with.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};

use crate::artifacts::id::ArtifactId;
use crate::artifacts::ingest::ARTIFACT_CHUNK_MAX_BYTES;
use crate::artifacts::manifest::ArtifactManifest;
use crate::jsonrpc::framing::MAX_ONE_ATTACHMENT_BYTES;
use crate::jsonrpc::refusal::RefusalCode;
use crate::plan::{PlanId, PlanState};
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::Never;
use crate::wire::attachment::Bytes;
use crate::wire::integer::{BoundedInt, SafeInt};
use crate::wire::text::{ComposedText, NonEmptyText};

/// Asks for the artifacts of one session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ArtifactListRequest {
    /// The session whose artifacts to list.
    pub session_id: SessionId,
}

/// One artifact in a session's list: a plan the agent finished, with its first heading and the
/// state word its plan record holds, or a file or folder a chat wrote, with its path in the chat's
/// workspace and how many versions it has. Each carries its newest manifest; a folder's media type
/// is `inode/directory`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum ArtifactListEntry {
    /// A plan the agent finished.
    Plan {
        /// The plan's manifest.
        #[garde(dive)]
        manifest: ArtifactManifest,
        /// The plan.
        plan_id: PlanId,
        /// The plan's first heading.
        title: String,
        /// The state word its plan record holds.
        state: PlanState,
    },
    /// A file or folder a chat wrote.
    File {
        /// The newest version's manifest.
        #[garde(dive)]
        manifest: ArtifactManifest,
        /// Its path in the chat's workspace.
        path: ComposedText,
        /// How many versions it has; a folder's is 1.
        version_count: SafeInt<1>,
    },
}

/// The session's artifacts.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactListResponse {
    /// The artifacts, each with its newest manifest.
    #[garde(dive)]
    pub artifacts: Vec<ArtifactListEntry>,
}

/// [`ARTIFACT_CHUNK_MAX_BYTES`] as a window's largest length.
#[expect(clippy::cast_possible_wrap, reason = "512 KiB fits an i64")]
const CHUNK_MAX_LENGTH: i64 = ARTIFACT_CHUNK_MAX_BYTES as i64;

/// How much of the payload a read returns: the handle only, the bytes when they fit in one message
/// (the handle otherwise, so a large payload is read window by window), or one window of `length`
/// bytes from `offset`, counted from 0. A window reaching past the payload's end answers the bytes
/// up to the end.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ArtifactPayloadSelection {
    /// The handle only.
    None {},
    /// The whole payload when it fits one message.
    Whole {},
    /// One window of the payload.
    Range {
        /// The window's first byte, from 0.
        offset: SafeInt<0>,
        /// The window's length in bytes, at most one chunk.
        length: BoundedInt<1, CHUNK_MAX_LENGTH>,
    },
}

/// Asks for one artifact: its manifest, a handle, and as much of the payload as `payloadSelection`
/// picks. `version` counts from 1, oldest first; without it the read answers the newest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ArtifactReadRequest {
    /// The artifact to read.
    pub artifact_id: ArtifactId,
    /// The version to read, from 1; absent for the newest.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SafeInt<1>")]
    pub version: Option<SafeInt<1>>,
    /// How much of the payload to answer.
    pub payload_selection: ArtifactPayloadSelection,
}

/// A picture's width and height in pixels, read from its header when its bytes were stored, its
/// orientation applied, so it is the size the picture is drawn at.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactPictureSize {
    /// The width in pixels.
    pub width: SafeInt<1>,
    /// The height in pixels.
    pub height: SafeInt<1>,
}

/// A PDF's first page, generated at ingest and stored as an artifact of its own, and how many
/// pages the PDF has.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactPdfPreview {
    /// The artifact holding the first page.
    pub first_page_artifact_id: ArtifactId,
    /// How many pages the PDF has.
    pub page_count: SafeInt<1>,
}

/// Whether `version_number` lies within `version_count`.
fn is_version_in_count(version_number: SafeInt<1>, version_count: SafeInt<1>) -> garde::Result {
    if version_number.get() <= version_count.get() {
        Ok(())
    } else {
        Err(garde::Error::new(
            "versionNumber must not exceed versionCount",
        ))
    }
}

/// Declares one arm of [`ArtifactReadResponse`]: the members every read answers beside the
/// payload, then the arm's own.
macro_rules! artifact_read_arm {
    ($(#[doc = $doc:literal])+ $name:ident { $($arm:tt)* }) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[schemars(inline)]
        #[garde(allow_unvalidated)]
        pub struct $name {
            /// The manifest of the version in view; its `createdAt` is when that version was
            /// written.
            #[garde(dive)]
            pub manifest: ArtifactManifest,
            /// The version in view, from 1, oldest first; never above `versionCount`.
            #[garde(custom(|number: &SafeInt<1>, (): &()| {
                is_version_in_count(*number, self.version_count)
            }))]
            #[schemars(extend("maximum" = { "$data": "1/versionCount" }))]
            pub version_number: SafeInt<1>,
            /// How many versions exist; 1 for a plan and any artifact no chat wrote.
            pub version_count: SafeInt<1>,
            /// A picture's size; present only on a picture.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "ArtifactPictureSize")]
            pub natural_size: Option<ArtifactPictureSize>,
            /// A PDF's first page; present only on a PDF whose first page could be generated.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "ArtifactPdfPreview")]
            pub pdf_preview: Option<ArtifactPdfPreview>,
            $($arm)*
        }
    };
}

artifact_read_arm! {
    /// The reply that hands back a key for the bytes, not the bytes; a reader fetches them with
    /// ranged reads.
    ArtifactReadDeferred {
        /// The content-store key or address for the payload.
        pub payload_handle: NonEmptyText,
        /// Absent: this arm carries no bytes.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub payload: Option<Never>,
    }
}

artifact_read_arm! {
    /// The reply that carries the bytes: the whole payload, or the window a ranged read asked for.
    ArtifactReadInline {
        /// The content-store key or address for the payload; a reply may return both.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "NonEmptyText")]
        pub payload_handle: Option<NonEmptyText>,
        /// The bytes.
        pub payload: Bytes<0, MAX_ONE_ATTACHMENT_BYTES>,
    }
}

/// What a read answers: the manifest, plus either a handle to fetch the bytes with or the bytes. A
/// read whose payload would not fit one message gets the handle arm, a served answer rather than a
/// refusal.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
pub enum ArtifactReadResponse {
    /// The handle, no bytes.
    Deferred(#[garde(dive)] ArtifactReadDeferred),
    /// The bytes.
    Inline(#[garde(dive)] ArtifactReadInline),
}

ts_constants! {
    /// Every refusal an artifact call answers with.
    pub const ARTIFACT_REFUSAL_CODES: [RefusalCode; 6] = [
        RefusalCode::ArtifactNotFound,
        RefusalCode::ArtifactTooLarge,
        RefusalCode::ArtifactFilePublishRefused,
        RefusalCode::ArtifactIdempotencyConflict,
        RefusalCode::ArtifactIngestCapacityExhausted,
        RefusalCode::ArtifactIngestStreamInvalid,
    ];
}

/// A refusal an artifact call answers with: one of [`ARTIFACT_REFUSAL_CODES`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct ArtifactRefusalCode(RefusalCode);

impl ArtifactRefusalCode {
    /// The refusal code.
    pub const fn code(self) -> RefusalCode {
        self.0
    }
}

impl<'de> Deserialize<'de> for ArtifactRefusalCode {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let code = RefusalCode::deserialize(deserializer)?;
        if ARTIFACT_REFUSAL_CODES.contains(&code) {
            Ok(Self(code))
        } else {
            Err(D::Error::custom(format!(
                "{} is not an artifact refusal",
                code.as_str()
            )))
        }
    }
}

impl JsonSchema for ArtifactRefusalCode {
    fn schema_name() -> Cow<'static, str> {
        "ArtifactRefusalCode".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        let codes: Vec<&str> = ARTIFACT_REFUSAL_CODES
            .iter()
            .map(|code| code.as_str())
            .collect();
        json_schema!({
            "description": "A refusal an artifact call answers with.",
            "type": "string",
            "enum": codes,
        })
    }
}

/// Why an `artifact.ingest.streamInvalid` stream call cannot go on, carried as its `reason`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum IngestStreamInvalidReason {
    /// The id names no live stream.
    UnknownStream,
    /// A chunk broke the sequence.
    SequenceBroken,
    /// The stream outlived its lifetime.
    LifetimeExpired,
    /// A chunk came after the completion.
    AlreadyCompleted,
    /// A completion record disagrees with the digest its stream committed.
    CompletionRecordMismatch,
}

/// Why an `artifact.tooLarge` refusal was raised, carried as its `reason`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ArtifactTooLargeReason {
    /// The file was declared larger than the disk has room for.
    VolumeTooSmall,
    /// The stream sent more than it declared.
    DeclaredSizeExceeded,
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "artifacts/operations",
    doc: "Listing a session's artifacts and reading one of them, and the refusal codes the \
          artifact calls answer with.",
    definitions: &[
        Definition::read::<ArtifactListRequest>().checked(),
        Definition::read::<ArtifactListEntry>(),
        Definition::read::<ArtifactListResponse>().checked(),
        Definition::read::<ArtifactPayloadSelection>(),
        Definition::read::<ArtifactReadRequest>().checked(),
        Definition::read::<ArtifactPictureSize>(),
        Definition::read::<ArtifactPdfPreview>(),
        Definition::read::<ArtifactReadResponse>().checked(),
        Definition::read::<ArtifactRefusalCode>(),
        Definition::read::<IngestStreamInvalidReason>(),
        Definition::read::<ArtifactTooLargeReason>(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
