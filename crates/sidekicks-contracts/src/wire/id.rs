//! What every id on the wire checks. A UUID id accepts any RFC 9562 text form in either case, the
//! Nil and Max UUIDs among them, since the daemon mints version 7 and the control plane's rows take
//! version 4; a text id is an opaque string within a bound.

use std::borrow::Cow;
use std::sync::LazyLock;

use regex::Regex;
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};

use crate::wire::text::is_within_length;

/// The RFC 9562 UUID text form, any version from 1 to 8 with the RFC variant, or the Nil or Max
/// UUID, in either case. Each case is spelled out, so Rust and ECMAScript read it alike.
pub const UUID_TEXT_FORM_PATTERN: &str = "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-\
                                          [89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\
                                          |00000000-0000-0000-0000-000000000000\
                                          |[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$";

/// [`UUID_TEXT_FORM_PATTERN`], compiled once.
static UUID_TEXT_FORM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(UUID_TEXT_FORM_PATTERN).expect("the UUID text form is a valid regex")
});

/// Why an id was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum IdError {
    /// The text is not an RFC 9562 UUID text form.
    #[error("the id is not an RFC 9562 UUID text form")]
    NotUuid,
    /// The text is empty or longer than the id's bound, counted in code points.
    #[error("the id is empty or longer than {max} code points")]
    OutOfBounds {
        /// The longest id accepted.
        max: usize,
    },
}

/// Checks `text` against the UUID text form.
pub fn check_uuid_text(text: &str) -> Result<(), IdError> {
    if UUID_TEXT_FORM.is_match(text) {
        Ok(())
    } else {
        Err(IdError::NotUuid)
    }
}

/// Checks that `text` holds `1..=max` code points.
pub fn check_bounded_text(text: &str, max: usize) -> Result<(), IdError> {
    if is_within_length(text, 1, max) {
        Ok(())
    } else {
        Err(IdError::OutOfBounds { max })
    }
}

/// A UUID whose brand another contract declares: the same accept set as every UUID id, read as a
/// plain string.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct UuidTextForm(String);

impl UuidTextForm {
    /// Checks `text`; refuses anything but the UUID text form.
    pub fn new(text: String) -> Result<Self, IdError> {
        check_uuid_text(&text).map(|()| Self(text))
    }

    /// The text as received.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for UuidTextForm {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(String::deserialize(deserializer)?).map_err(D::Error::custom)
    }
}

impl JsonSchema for UuidTextForm {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "UuidTextForm".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "string", "pattern": UUID_TEXT_FORM_PATTERN })
    }
}

/// A client-minted UUID: versions 1 to 8 in either letter case, or the Nil or Max UUID in lower
/// case.
const CLIENT_UUID_PATTERN: &str = "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}\
                                   -[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\
                                   |00000000-0000-0000-0000-000000000000\
                                   |ffffffff-ffff-ffff-ffff-ffffffffffff)$";

/// [`CLIENT_UUID_PATTERN`], compiled once.
static CLIENT_UUID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(CLIENT_UUID_PATTERN).expect("the client UUID is a valid regex"));

/// A UUID a client mints, such as a staging id or an idempotency key, that no brand names.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct ClientUuid(String);

impl ClientUuid {
    /// Checks `text`; refuses anything but a client UUID.
    pub fn new(text: String) -> Option<Self> {
        CLIENT_UUID.is_match(&text).then_some(Self(text))
    }

    /// The UUID's text as received.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for ClientUuid {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(String::deserialize(deserializer)?)
            .ok_or_else(|| D::Error::custom("Invalid UUID"))
    }
}

impl JsonSchema for ClientUuid {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "ClientUuid".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "string", "pattern": CLIENT_UUID_PATTERN })
    }
}
