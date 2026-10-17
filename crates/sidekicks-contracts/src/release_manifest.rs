//! The release manifest: the JSON file a release publishes beside its artifacts, and the version a
//! release carries. `sidekicks daemon update` reads the manifest, checks each download against its
//! SHA-256 and refuses a manifest whose `version` is not above the last one it saw; that record is
//! the reader's. Members keep the published file's snake case, since tools outside this crate read
//! it too.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::web_address::HttpsAddress;
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::record::Record;
use crate::wire::text::{BoundedText, pattern_text};

ts_constants! {
    /// The longest release version accepted.
    pub const RELEASE_VERSION_MAX_LEN: usize = 64;
    /// The longest artifact name or artifact address a manifest carries.
    pub const RELEASE_MANIFEST_FIELD_MAX_LEN: usize = 2048;
}

pattern_text! {
    /// A release's version as a person reads it, `0.1.0` or `1.4.0-beta.2`: `MAJOR.MINOR.PATCH`
    /// with an optional pre-release and build suffix.
    pub struct ReleaseVersion(
        "^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$",
        max = RELEASE_VERSION_MAX_LEN
    );
    /// A SHA-256 digest in lowercase hex.
    pub struct Sha256Hex("^[0-9a-f]{64}$");
}

/// One published artifact: where to fetch it, over `https`, and the SHA-256 of its bytes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReleaseManifestArtifact {
    /// Where to fetch it.
    pub url: HttpsAddress<RELEASE_MANIFEST_FIELD_MAX_LEN>,
    /// The SHA-256 of its bytes.
    pub sha256: Sha256Hex,
}

/// A release manifest as published.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct ReleaseManifest {
    /// A whole number that rises with every release, never reused.
    pub version: SafeInt<1>,
    /// When the release was published.
    #[garde(dive)]
    pub released_at: WireInstant,
    /// Each artifact keyed by its platform name, `linux-x64` or `darwin-arm64`.
    pub artifacts: Record<BoundedText<1, RELEASE_MANIFEST_FIELD_MAX_LEN>, ReleaseManifestArtifact>,
}

/// The TypeScript module of the release manifest.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "release-manifest",
    doc: "The release manifest: the JSON file a release publishes beside its artifacts, and the \
          version a release carries.",
    definitions: &[
        Definition::read::<ReleaseVersion>(),
        Definition::read::<Sha256Hex>(),
        Definition::read::<ReleaseManifestArtifact>(),
        Definition::read::<ReleaseManifest>(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
