//! The relay pin: what the service records when a pinned relay presents a different key, and the
//! request that accepts the relay's new key. A relay's key is pinned only when its certificate does
//! not chain to a root the operating system trusts, since such a relay makes a new key at every
//! renewal and nothing else vouches for it. Hashes are SHA-256 over the certificate's public key in
//! lowercase hex, so the prefix a refusal records is the start of the hash the person pastes.

use std::borrow::Cow;
use std::sync::LazyLock;

use regex::Regex;
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};

use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::release_manifest::Sha256Hex;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::text::{is_within_length, pattern_text};

/// A host name's labels: letters, digits and inner hyphens, each 1 to 63 characters, joined by
/// dots, with an optional final dot.
const HOSTNAME_PATTERN: &str = "^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9]\
                                (?:[-0-9a-zA-Z]{0,61}[0-9a-zA-Z])?)*\\.?$";

/// [`HOSTNAME_PATTERN`], compiled once.
static HOSTNAME_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(HOSTNAME_PATTERN).expect("the host name pattern is a valid regex"));

/// The longest host name, its optional final dot aside.
const HOSTNAME_MAX_LEN: usize = 253;

/// A DNS host name: labels of letters, digits and inner hyphens, at most 253 characters before an
/// optional final dot.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct Hostname(String);

impl Hostname {
    /// `text` when it is a host name, else `None`.
    pub fn new(text: String) -> Option<Self> {
        let labels = text.strip_suffix('.').unwrap_or(&text);
        let is_hostname =
            is_within_length(labels, 0, HOSTNAME_MAX_LEN) && HOSTNAME_REGEX.is_match(&text);
        is_hostname.then_some(Self(text))
    }

    /// The host name.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for Hostname {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(String::deserialize(deserializer)?)
            .ok_or_else(|| D::Error::custom("not a host name"))
    }
}

impl JsonSchema for Hostname {
    fn schema_name() -> Cow<'static, str> {
        "Hostname".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        // The pattern admits only ASCII, so a code-point length is its byte length.
        json_schema!({
            "description": "A DNS host name: labels of letters, digits and inner hyphens, at most \
                            253 characters before an optional final dot.",
            "type": "string",
            "pattern": HOSTNAME_PATTERN,
            "anyOf": [
                { "type": "string", "maxLength": HOSTNAME_MAX_LEN },
                { "type": "string", "maxLength": HOSTNAME_MAX_LEN + 1, "pattern": "\\.$" },
            ],
        })
    }
}

pattern_text! {
    /// The first 8 bytes of a key hash: 16 lowercase hex characters.
    pub struct SpkiPrefix("^[0-9a-f]{16}$");
}

/// The `relay.pin_refused` event's payload, recorded on the service's own sentinel session: the
/// relay's host and the first 8 bytes of the pinned and the presented key hashes, never a token.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelayPinRefusedPayload {
    /// The relay's host.
    pub relay_host: Hostname,
    /// The start of the pinned key's hash.
    pub pinned_spki_prefix: SpkiPrefix,
    /// The start of the presented key's hash.
    pub presented_spki_prefix: SpkiPrefix,
}

/// `sidekicks relay repin --force`: the new key hash the person pasted becomes the pin.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelayRepinRequest {
    /// The full SHA-256 of the relay's new key.
    pub spki_hash: Sha256Hex,
}

methods! {
    /// The relay method the service answers.
    pub const RELAY_METHOD_DESCRIPTORS = [
        /// Accepts the relay's new key; refused, changing nothing, when the hash does not match
        /// the key the relay presents.
        RelayRepin = mutation "relay.repin" {
            mutating: true,
            params: RelayRepinRequest,
            result: EmptyPayload,
            refusals: [RelaySpkiMismatch],
        },
    ];
}

/// The TypeScript module of the relay pin.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "relay",
    doc: "The relay pin: what the service records when a pinned relay presents a different key, \
          and the request that accepts the relay's new key.",
    definitions: &[
        Definition::read::<Hostname>(),
        Definition::read::<SpkiPrefix>(),
        Definition::read::<RelayPinRefusedPayload>(),
        Definition::read::<RelayRepinRequest>(),
    ],
    constants: &[],
    method_tables: &[&RELAY_METHOD_DESCRIPTORS],
};
