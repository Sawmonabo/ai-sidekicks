//! The one rule every web address the app opens is held to: only `http:` and `https:`. A user name
//! or a password in the authority is part of an address as typed and is not refused. Only an
//! already parsed address is judged; turning typed text into an address is the caller's parsing.
//!
//! The web addresses a message carries are read as the TypeScript checks read them: the text
//! trimmed of ECMAScript whitespace, then parsed by the WHATWG URL standard, which the `url` crate
//! follows, and kept without the ASCII tabs and line breaks that parser skips. A cap counts the
//! text as it crosses the wire, before any of that.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};
use strum::VariantArray;
use url::Url;

use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::text::{ecmascript_whitespace, is_ecmascript_whitespace, is_within_length};

ts_constants! {
    /// The schemes a web address may carry, in the WHATWG parser's form, which is always lower
    /// case and ends in a colon.
    pub const WEB_ADDRESS_SCHEMES: &[&str] = &["http:", "https:"];
    /// Every [`WebAddressFault`].
    WEB_ADDRESS_FAULTS = WebAddressFault::VARIANTS;
}

/// Why a parsed address is not a web address the app opens: `scheme` when its scheme is neither
/// `http:` nor `https:`.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "lowercase")]
pub enum WebAddressFault {
    /// The scheme is neither `http:` nor `https:`.
    Scheme,
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

/// An `https:` address with no NUL, of at most `MAX` code points as sent (`usize::MAX` leaves it
/// bounded only by the message cap). The schema names the `https-url` format, which the
/// TypeScript checks register.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct HttpsAddress<const MAX: usize>(String);

impl<const MAX: usize> HttpsAddress<MAX> {
    /// `text` as kept when it is within the cap, holds no NUL and parses as an `https:` address,
    /// else `None`.
    pub fn new(text: String) -> Option<Self> {
        if !is_within_length(&text, 0, MAX) || text.contains('\0') {
            return None;
        }
        let trimmed = text.trim_matches(is_ecmascript_whitespace);
        let is_https = Url::parse(trimmed).is_ok_and(|address| address.scheme() == "https");
        is_https.then(|| Self(kept_text(trimmed)))
    }

    /// The address as kept.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de, const MAX: usize> Deserialize<'de> for HttpsAddress<MAX> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(String::deserialize(deserializer)?).ok_or_else(|| {
            D::Error::custom(format!(
                "not an https: address with no NUL of at most {MAX} code points"
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
        let mut schema =
            json_schema!({ "type": "string", "format": "https-url", "pattern": NUL_FREE_PATTERN });
        if MAX != usize::MAX {
            schema.insert("maxLength".into(), MAX.into());
        }
        schema
    }
}

/// The start an `http:` or `https:` address must be written with, after its leading whitespace,
/// so `http:example.com` is refused rather than read as a host.
const HTTP_START_PATTERN: &str =
    concat!("^[", ecmascript_whitespace!(), "]*[hH][tT][tT][pP][sS]?://");

/// Text with no NUL, which the URL parser would otherwise percent-encode into the kept address.
const NUL_FREE_PATTERN: &str = "^[^\\x00]*$";

/// An `http:` or `https:` address, written with its `//`. The schema states the scheme only; the
/// Rust parser also refuses an address the URL standard cannot parse.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct WebAddress(String);

impl WebAddress {
    /// `text` as kept when it is an `http:` or `https:` address written with its `//`, else
    /// `None`.
    pub fn new(text: String) -> Option<Self> {
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
        Self::new(String::deserialize(deserializer)?)
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

    use super::{HttpsAddress, WebAddress, WebAddressFault, web_address_fault};

    /// The cap the `capped` rows are read under; the test's `HttpsAddress` takes it as written.
    const HTTPS_CAP: usize = 20;

    /// The case table: parsed addresses and their faults, text as a message carries it, and text
    /// read under a cap of `httpsCap` code points.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct CaseTable {
        faults: Vec<FaultCase>,
        texts: Vec<TextCase>,
        https_cap: usize,
        capped: Vec<CappedCase>,
    }

    /// A parsed address and the fault it must draw, or none.
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct FaultCase {
        address: String,
        fault: Option<WebAddressFault>,
    }

    /// Text as a message carries it and what each address type keeps of it, uncapped, or `None`
    /// when the type refuses it.
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct TextCase {
        name: String,
        text: String,
        web: Option<String>,
        https: Option<String>,
    }

    /// Text and what an `https:` address under the cap keeps of it, or `None` when refused.
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct CappedCase {
        name: String,
        text: String,
        https: Option<String>,
    }

    fn case_table() -> CaseTable {
        serde_json::from_str(include_str!("../tests/fixtures/web-address.json"))
            .expect("the case table reads")
    }

    #[test]
    fn an_address_passes_only_with_a_web_scheme() {
        for case in case_table().faults {
            let address = Url::parse(&case.address).expect("each address parses");
            assert_eq!(web_address_fault(&address), case.fault, "{}", case.address);
        }
    }

    #[test]
    fn keeps_text_as_the_typescript_url_check_keeps_it() {
        for case in case_table().texts {
            let web = WebAddress::new(case.text.clone()).map(|address| address.as_str().to_owned());
            assert_eq!(web, case.web, "web address: {}", case.name);
            let https = HttpsAddress::<{ usize::MAX }>::new(case.text)
                .map(|address| address.as_str().to_owned());
            assert_eq!(https, case.https, "https address: {}", case.name);
        }
    }

    #[test]
    fn caps_an_https_address_as_sent() {
        let table = case_table();
        assert_eq!(
            table.https_cap, HTTPS_CAP,
            "the table's cap is the one the test reads under"
        );
        for case in table.capped {
            let https = HttpsAddress::<HTTPS_CAP>::new(case.text)
                .map(|address| address.as_str().to_owned());
            assert_eq!(https, case.https, "{}", case.name);
        }
    }
}
