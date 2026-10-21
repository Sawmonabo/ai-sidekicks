//! Bytes a signed or stored JSON value carries as base64 text, read as the TypeScript checks read
//! it: the standard alphabet with canonical padding, no whitespace, and stray bits after the last
//! byte allowed. Bytes a message carries in bulk travel as attachments instead.

use std::borrow::Cow;

use base64::Engine;
use base64::alphabet::{STANDARD, URL_SAFE};
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::wire::text::is_within_length;

/// The standard alphabet as `atob` reads it.
pub const STANDARD_BASE64: GeneralPurpose = GeneralPurpose::new(
    &STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_allow_trailing_bits(true)
        .with_decode_padding_mode(DecodePaddingMode::RequireCanonical),
);

/// The URL-safe alphabet with no padding, as `WebAuthn` hands its parts over.
const URL_SAFE_BASE64: GeneralPurpose = GeneralPurpose::new(
    &URL_SAFE,
    GeneralPurposeConfig::new()
        .with_encode_padding(false)
        .with_decode_allow_trailing_bits(true)
        .with_decode_padding_mode(DecodePaddingMode::RequireNone),
);

/// Standard base64 of any length, padding included.
const STANDARD_PATTERN: &str = "^(?:[0-9a-zA-Z+/]{4})*(?:[0-9a-zA-Z+/]{2}==|[0-9a-zA-Z+/]{3}=)?$";

/// URL-safe base64 with no padding.
const URL_SAFE_PATTERN: &str = "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$";

/// The pattern of exactly `bytes` bytes in standard base64.
fn exact_pattern(bytes: usize) -> String {
    let full = bytes / 3 * 4;
    match bytes % 3 {
        0 => format!("^[A-Za-z0-9+/]{{{full}}}$"),
        1 => format!("^[A-Za-z0-9+/]{{{}}}==$", full + 2),
        _ => format!("^[A-Za-z0-9+/]{{{}}}=$", full + 3),
    }
}

/// Exactly `N` bytes, written as standard base64: a public key.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Base64Array<const N: usize>(Box<[u8; N]>);

impl<const N: usize> Base64Array<N> {
    /// The bytes.
    pub fn as_bytes(&self) -> &[u8; N] {
        &self.0
    }
}

impl<const N: usize> Serialize for Base64Array<N> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&STANDARD_BASE64.encode(&self.0[..]))
    }
}

impl<'de, const N: usize> Deserialize<'de> for Base64Array<N> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let bytes = STANDARD_BASE64
            .decode(String::deserialize(deserializer)?)
            .map_err(D::Error::custom)?;
        let length = bytes.len();
        let bytes: Box<[u8; N]> = bytes
            .into_boxed_slice()
            .try_into()
            .map_err(|_bytes| D::Error::custom(format!("{length} bytes where {N} belong")))?;
        Ok(Self(bytes))
    }
}

impl<const N: usize> JsonSchema for Base64Array<N> {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        format!("Base64Array{N}").into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "string", "pattern": exact_pattern(N) })
    }
}

/// Standard base64 text of `MIN..=MAX` characters: a signature.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct Base64Text<const MIN: usize, const MAX: usize>(String);

impl<'de, const MIN: usize, const MAX: usize> Deserialize<'de> for Base64Text<MIN, MAX> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        if !is_within_length(&text, MIN, MAX) {
            return Err(D::Error::custom(format!(
                "base64 text is outside {MIN}..={MAX} characters"
            )));
        }
        STANDARD_BASE64.decode(&text).map_err(D::Error::custom)?;
        Ok(Self(text))
    }
}

impl<const MIN: usize, const MAX: usize> Base64Text<MIN, MAX> {
    /// The base64 text.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<const MIN: usize, const MAX: usize> JsonSchema for Base64Text<MIN, MAX> {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        format!("Base64Text{MIN}To{MAX}").into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "string",
            "minLength": MIN,
            "maxLength": MAX,
            "pattern": STANDARD_PATTERN,
        })
    }
}

/// URL-safe base64 text with no padding, of `MIN..=MAX` characters: a `WebAuthn` part.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct Base64UrlText<const MIN: usize, const MAX: usize>(String);

impl<'de, const MIN: usize, const MAX: usize> Deserialize<'de> for Base64UrlText<MIN, MAX> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        if !is_within_length(&text, MIN, MAX) {
            return Err(D::Error::custom(format!(
                "base64url text is outside {MIN}..={MAX} characters"
            )));
        }
        URL_SAFE_BASE64.decode(&text).map_err(D::Error::custom)?;
        Ok(Self(text))
    }
}

impl<const MIN: usize, const MAX: usize> Base64UrlText<MIN, MAX> {
    /// `bytes` as base64url text, or `None` when the text falls outside `MIN..=MAX` characters.
    pub fn encode(bytes: &[u8]) -> Option<Self> {
        let text = URL_SAFE_BASE64.encode(bytes);
        is_within_length(&text, MIN, MAX).then_some(Self(text))
    }

    /// The bytes the text holds.
    pub fn decode(&self) -> Vec<u8> {
        URL_SAFE_BASE64
            .decode(&self.0)
            .expect("the text was checked as base64url when it was made")
    }

    /// The base64url text.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<const MIN: usize, const MAX: usize> JsonSchema for Base64UrlText<MIN, MAX> {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        format!("Base64UrlText{MIN}To{MAX}").into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "string",
            "minLength": MIN,
            "maxLength": MAX,
            "pattern": URL_SAFE_PATTERN,
        })
    }
}

/// Standard base64 text of 1 to `MAX` bytes once decoded: a sealed notice. Its schema states the
/// decoded bound exactly: past the last whole group, a final group's padding says how many bytes
/// it holds.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct Base64Bytes<const MAX: usize>(String);

impl<const MAX: usize> Base64Bytes<MAX> {
    /// The base64 text.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de, const MAX: usize> Deserialize<'de> for Base64Bytes<MAX> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        let length = STANDARD_BASE64
            .decode(&text)
            .map_err(D::Error::custom)?
            .len();
        if !(1..=MAX).contains(&length) {
            return Err(D::Error::custom(format!(
                "{length} bytes is outside 1..={MAX}"
            )));
        }
        Ok(Self(text))
    }
}

impl<const MAX: usize> JsonSchema for Base64Bytes<MAX> {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        format!("Base64Bytes{MAX}").into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        let longest = MAX.div_ceil(3) * 4;
        let mut schema = json_schema!({
            "type": "string",
            "minLength": 1,
            "maxLength": longest,
            "pattern": STANDARD_PATTERN,
        });
        // At the longest length, the last group must be padded down to the bytes `MAX` leaves it.
        let last_group_padding = match MAX % 3 {
            1 => Some("==$"),
            2 => Some("=$"),
            _ => None,
        };
        if let Some(padding) = last_group_padding {
            schema.insert(
                "anyOf".into(),
                serde_json::json!([
                    { "type": "string", "maxLength": longest - 4 },
                    { "type": "string", "pattern": padding },
                ]),
            );
        }
        schema
    }
}
