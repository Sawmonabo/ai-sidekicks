//! What every id on the wire checks, and the one minter of the ids the daemon and the control plane
//! store. Both mint version 7, yet a UUID id accepts any RFC 9562 text form in either case, the Nil
//! and Max UUIDs among them, since a client mints its own; it is held as its 16 bytes and written
//! lowercase, so two spellings of one UUID are one id.

use std::borrow::Cow;
use std::fmt;
use std::str::FromStr;
use std::sync::LazyLock;

use regex::Regex;
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::{Error as _, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use uuid::fmt::Hyphenated;
use uuid::{Uuid, Variant};

/// The RFC 9562 UUID text form, any version from 1 to 8 with the RFC variant, or the Nil or Max
/// UUID, in either case. Each case is spelled out, so Rust and ECMAScript read it alike.
pub const UUID_TEXT_FORM_PATTERN: &str = "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-\
                                          [89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\
                                          |00000000-0000-0000-0000-000000000000\
                                          |[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$";

/// A new version 7 UUID from the process-wide context, so ids minted in one process strictly
/// increase, within one millisecond too: every stored row id and event id the daemon and the
/// control plane mint. On the Worker it reads `Date.now()` through `uuid`'s `js` feature.
#[expect(
    clippy::disallowed_methods,
    reason = "this is the one place stored row and event ids are minted"
)]
pub fn mint_uuid_v7() -> Uuid {
    Uuid::now_v7()
}

/// Why an id was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum IdError {
    /// The text is not an RFC 9562 UUID text form.
    #[error("the id is not an RFC 9562 UUID text form")]
    NotUuid,
}

/// Reads `text` as a UUID in the form [`UUID_TEXT_FORM_PATTERN`] accepts; refuses the simple,
/// braced and URN forms `Uuid::from_str` also takes, and any other text, with
/// [`IdError::NotUuid`].
pub(crate) fn parse_uuid_text(text: &str) -> Result<Uuid, IdError> {
    Hyphenated::from_str(text)
        .ok()
        .map(Hyphenated::into_uuid)
        .filter(|&uuid| is_uuid_text_form(uuid))
        .ok_or(IdError::NotUuid)
}

/// Whether `uuid` is one [`UUID_TEXT_FORM_PATTERN`] accepts: a version from 1 to 8 with the RFC
/// variant, or the Nil or Max UUID.
pub(crate) fn is_uuid_text_form(uuid: Uuid) -> bool {
    let is_versioned =
        uuid.get_variant() == Variant::RFC4122 && (1..=8).contains(&uuid.get_version_num());
    is_versioned || uuid.is_nil() || uuid.is_max()
}

/// Reads a UUID in the text form, borrowing the text where the reader can.
pub(crate) fn deserialize_uuid_text<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Uuid, D::Error> {
    deserializer.deserialize_str(UuidTextVisitor)
}

/// The visitor [`deserialize_uuid_text`] reads with.
struct UuidTextVisitor;

impl Visitor<'_> for UuidTextVisitor {
    type Value = Uuid;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a UUID in the RFC 9562 text form")
    }

    fn visit_str<E: serde::de::Error>(self, text: &str) -> Result<Uuid, E> {
        parse_uuid_text(text).map_err(E::custom)
    }
}

/// A UUID's lowercase hyphenated text, held on the stack: what a UUID id writes on the wire and
/// binds to a TEXT column.
#[derive(Clone, Copy)]
pub struct UuidText([u8; Hyphenated::LENGTH]);

impl UuidText {
    /// `uuid`'s lowercase hyphenated text.
    pub(crate) fn new(uuid: Uuid) -> Self {
        let mut text = [0; Hyphenated::LENGTH];
        uuid.hyphenated().encode_lower(&mut text);
        Self(text)
    }

    /// The text.
    pub fn as_str(&self) -> &str {
        std::str::from_utf8(&self.0).expect("a UUID's text is hex digits and hyphens")
    }
}

/// A UUID whose brand another contract declares: the same accept set as every UUID id, written
/// lowercase, read as a plain string.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct UuidTextForm(Uuid);

impl UuidTextForm {
    /// Reads `text`; refuses anything but the UUID text form.
    pub fn new(text: &str) -> Result<Self, IdError> {
        parse_uuid_text(text).map(Self)
    }

    /// The UUID in its lowercase text form, as the wire and the store write it.
    pub fn text(&self) -> UuidText {
        UuidText::new(self.0)
    }
}

impl From<Uuid> for UuidTextForm {
    fn from(uuid: Uuid) -> Self {
        Self(uuid)
    }
}

impl Serialize for UuidTextForm {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.text().as_str())
    }
}

impl<'de> Deserialize<'de> for UuidTextForm {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserialize_uuid_text(deserializer).map(Self)
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
    pub fn new(text: String) -> Result<Self, IdError> {
        if CLIENT_UUID.is_match(&text) {
            Ok(Self(text))
        } else {
            Err(IdError::NotUuid)
        }
    }

    /// The UUID's text as received.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for ClientUuid {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(String::deserialize(deserializer)?).map_err(|error| match error {
            IdError::NotUuid => D::Error::custom("Invalid UUID"),
        })
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

#[cfg(test)]
mod tests {
    use regex::Regex;
    use rstest::rstest;

    use super::{UUID_TEXT_FORM_PATTERN, mint_uuid_v7, parse_uuid_text};

    #[test]
    fn a_burst_of_ids_strictly_increases() {
        let ids: Vec<_> = (0..10_000).map(|_| mint_uuid_v7()).collect();
        assert!(ids.windows(2).all(|pair| pair[0] < pair[1]));
    }

    /// The parser a UUID id reads with and the pattern its schema gives TypeScript accept the
    /// same text.
    #[rstest]
    #[case::version_7("0190f1c4-7e3a-7b1c-9d2e-3f4a5b6c7d8e", true)]
    #[case::version_4_upper_case("0190F1C4-7E3A-4B1C-AD2E-3F4A5B6C7D8E", true)]
    #[case::nil("00000000-0000-0000-0000-000000000000", true)]
    #[case::max("FFFFFFFF-ffff-FFFF-ffff-FFFFFFFFFFFF", true)]
    #[case::simple("0190f1c47e3a7b1c9d2e3f4a5b6c7d8e", false)]
    #[case::braced("{0190f1c4-7e3a-7b1c-9d2e-3f4a5b6c7d8e}", false)]
    #[case::urn("urn:uuid:0190f1c4-7e3a-7b1c-9d2e-3f4a5b6c7d8e", false)]
    #[case::version_0("0190f1c4-7e3a-0b1c-9d2e-3f4a5b6c7d8e", false)]
    #[case::version_9("0190f1c4-7e3a-9b1c-9d2e-3f4a5b6c7d8e", false)]
    #[case::microsoft_variant("0190f1c4-7e3a-7b1c-cd2e-3f4a5b6c7d8e", false)]
    #[case::trailing_newline("0190f1c4-7e3a-7b1c-9d2e-3f4a5b6c7d8e\n", false)]
    fn a_uuid_id_reads_what_its_schema_pattern_accepts(#[case] text: &str, #[case] accepted: bool) {
        let pattern = Regex::new(UUID_TEXT_FORM_PATTERN).expect("the pattern compiles");
        assert_eq!(parse_uuid_text(text).is_ok(), accepted);
        assert_eq!(pattern.is_match(text), accepted);
    }
}
