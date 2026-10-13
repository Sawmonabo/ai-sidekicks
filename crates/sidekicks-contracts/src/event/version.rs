//! The leaf of the session event contracts: the envelope's version and the cap on the envelope's
//! free-form strings. It uses no other `event` module, so every one of them can read it.

use std::borrow::Cow;
use std::sync::LazyLock;

use regex::Regex;
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};

use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::text::is_within_length;

/// The cap on the envelope's free-form strings (id, actor, correlation and causation ids), with
/// room for composite ids beyond a 36-character UUID, in code points.
pub const EVENT_FIELD_MAX_LEN: usize = 256;

/// The longest [`EventEnvelopeVersion`], checked before its pattern, so a version's digits stay
/// bounded.
pub const EVENT_ENVELOPE_VERSION_MAX_LEN: usize = 64;

/// The `"MAJOR.MINOR"` shape of an [`EventEnvelopeVersion`]: no leading zeros (`01.0`, `1.01`) and
/// exactly two segments (`1` and `1.0.0` are refused).
pub const EVENT_ENVELOPE_VERSION_PATTERN: &str = "^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)$";

/// [`EVENT_ENVELOPE_VERSION_PATTERN`], compiled once.
static VERSION_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(EVENT_ENVELOPE_VERSION_PATTERN).expect("the version pattern is a valid regex")
});

/// A producer's `"MAJOR.MINOR"` protocol version, written at emit time and never rewritten on
/// read. Its length and shape are checked here; an out-of-range version is refused at the protocol
/// handshake, never here.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct EventEnvelopeVersion(String);

impl EventEnvelopeVersion {
    /// `text` as a version, or `None` when it is longer than
    /// [`EVENT_ENVELOPE_VERSION_MAX_LEN`] or not `"MAJOR.MINOR"`.
    pub fn new(text: String) -> Option<Self> {
        let is_version = is_within_length(&text, 0, EVENT_ENVELOPE_VERSION_MAX_LEN)
            && VERSION_REGEX.is_match(&text);
        is_version.then_some(Self(text))
    }

    /// The version's text.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for EventEnvelopeVersion {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Self::new(text).ok_or_else(|| {
            D::Error::custom(format!(
                "an envelope version is \"MAJOR.MINOR\", at most \
                 {EVENT_ENVELOPE_VERSION_MAX_LEN} characters"
            ))
        })
    }
}

impl JsonSchema for EventEnvelopeVersion {
    fn schema_name() -> Cow<'static, str> {
        "EventEnvelopeVersion".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "description": "A producer's \"MAJOR.MINOR\" protocol version, written at emit time \
                            and never rewritten on read.",
            "type": "string",
            "maxLength": EVENT_ENVELOPE_VERSION_MAX_LEN,
            "pattern": EVENT_ENVELOPE_VERSION_PATTERN,
            "tsType": "string & { readonly __brand: \"EventEnvelopeVersion\" }",
        })
    }
}

/// The TypeScript module of the envelope's version.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "event/version",
    doc: "The leaf of the session event contracts: the envelope's version. It imports no other \
          event module, so every one of them can import it.",
    definitions: &[Definition::read::<EventEnvelopeVersion>().checked()],
    constants: &[],
    method_tables: &[],
};
