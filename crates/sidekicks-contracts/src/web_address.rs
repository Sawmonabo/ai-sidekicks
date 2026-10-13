//! The one rule every web address the app opens is held to: only `http:` and `https:`. A user name
//! or a password in the authority is part of an address as typed and is not refused. Only an
//! already parsed address is judged; turning typed text into an address is the caller's parsing.
//!
//! The web addresses a message carries are read as the TypeScript checks read them: the text
//! trimmed of ECMAScript whitespace, then parsed by the WHATWG URL standard, which the `url` crate
//! follows, and kept without the ASCII tabs and line breaks that parser skips.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};
use url::Url;

use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::text::is_ecmascript_whitespace;

ts_constants! {
    /// The schemes a web address may carry, in the WHATWG parser's form, which is always lower
    /// case and ends in a colon.
    pub const WEB_ADDRESS_SCHEMES: &[&str] = &["http:", "https:"];
    /// Every [`WebAddressFault`].
    WEB_ADDRESS_FAULTS = WebAddressFault::ALL;
}

/// Why a parsed address is not a web address the app opens: `scheme` when its scheme is neither
/// `http:` nor `https:`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum WebAddressFault {
    /// The scheme is neither `http:` nor `https:`.
    Scheme,
}

impl WebAddressFault {
    /// Every fault.
    pub const ALL: &[Self] = &[Self::Scheme];
}

/// Judges one parsed address against the rule: the fault, or `None` when it passes. The fault
/// names the class of the problem and never echoes the address, so it is safe to log.
pub fn web_address_fault(address: &Url) -> Option<WebAddressFault> {
    let scheme = address.scheme();
    let is_web = WEB_ADDRESS_SCHEMES
        .iter()
        .any(|allowed| allowed.strip_suffix(':') == Some(scheme));
    (!is_web).then_some(WebAddressFault::Scheme)
}

/// The address as kept: trimmed, with the ASCII tabs and line breaks the URL parser skips taken
/// out, so the kept text names the host the parser read.
fn kept_text(trimmed: &str) -> String {
    trimmed
        .chars()
        .filter(|character| !matches!(character, '\t' | '\n' | '\r'))
        .collect()
}

/// An `https:` address of at most `MAX` code points (`usize::MAX` leaves it bounded only by the
/// message cap), counted after trimming. The schema names the `https-url` format, which the
/// TypeScript checks register.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct HttpsAddress<const MAX: usize>(String);

impl<const MAX: usize> HttpsAddress<MAX> {
    /// `text` as kept when it parses as an `https:` address within the cap, else `None`.
    pub fn new(text: &str) -> Option<Self> {
        let trimmed = text.trim_matches(is_ecmascript_whitespace);
        let is_https = Url::parse(trimmed).is_ok_and(|address| address.scheme() == "https");
        let kept = kept_text(trimmed);
        let is_within_cap = MAX == usize::MAX || kept.chars().nth(MAX).is_none();
        (is_https && is_within_cap).then_some(Self(kept))
    }

    /// The address as kept.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de, const MAX: usize> Deserialize<'de> for HttpsAddress<MAX> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(&String::deserialize(deserializer)?).ok_or_else(|| {
            D::Error::custom(format!(
                "not an https: address of at most {MAX} code points"
            ))
        })
    }
}

impl<const MAX: usize> JsonSchema for HttpsAddress<MAX> {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        format!("HttpsAddress{MAX}").into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        let mut schema = json_schema!({ "type": "string", "format": "https-url" });
        if MAX != usize::MAX {
            schema.insert("maxLength".into(), MAX.into());
        }
        schema
    }
}

/// The start an `http:` or `https:` address must be written with, after its leading whitespace,
/// so `http:example.com` is refused rather than read as a host.
const HTTP_START_PATTERN: &str = "^[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\
                                  \\u202f\\u205f\\u3000\\ufeff]*[hH][tT][tT][pP][sS]?://";

/// An `http:` or `https:` address, written with its `//`. The schema states the scheme only; the
/// Rust parser also refuses an address the URL standard cannot parse.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct WebAddress(String);

impl WebAddress {
    /// `text` as kept when it is an `http:` or `https:` address written with its `//`, else
    /// `None`.
    pub fn new(text: &str) -> Option<Self> {
        let trimmed = text.trim_matches(is_ecmascript_whitespace);
        let is_written_with_slashes = trimmed
            .get(..7)
            .is_some_and(|start| start.eq_ignore_ascii_case("http://"))
            || trimmed
                .get(..8)
                .is_some_and(|start| start.eq_ignore_ascii_case("https://"));
        let is_web = Url::parse(trimmed).is_ok_and(|address| web_address_fault(&address).is_none());
        (is_written_with_slashes && is_web).then(|| Self(kept_text(trimmed)))
    }

    /// The address as kept.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for WebAddress {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(&String::deserialize(deserializer)?)
            .ok_or_else(|| D::Error::custom("the address is not an http: or https: address"))
    }
}

impl JsonSchema for WebAddress {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "WebAddress".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        // The pattern holds the start; the `web-url` format, the parse JavaScript's `URL` runs.
        json_schema!({ "type": "string", "format": "web-url", "pattern": HTTP_START_PATTERN })
    }
}

/// The TypeScript module of the web-address rule.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "web-address",
    doc: "The one rule every web address the app opens is held to: only `http:` and `https:`.",
    definitions: &[Definition::read::<WebAddressFault>()],
    constants: TS_CONSTANTS,
    method_tables: &[],
};

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use url::Url;

    use super::{WebAddressFault, web_address_fault};

    /// One case of the table the TypeScript rule also reads.
    #[derive(Deserialize)]
    struct WebAddressCase {
        address: String,
        fault: Option<WebAddressFault>,
    }

    #[test]
    fn an_address_passes_only_with_a_web_scheme() {
        let cases: Vec<WebAddressCase> =
            serde_json::from_str(include_str!("../tests/fixtures/web-address.json"))
                .expect("the case table reads");
        for case in cases {
            let address = Url::parse(&case.address).expect("each address parses");
            assert_eq!(web_address_fault(&address), case.fault, "{}", case.address);
        }
    }
}
