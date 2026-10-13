//! An instant a peer sends: RFC 3339 text with its offset, checked by one pattern that the garde
//! check and the JSON Schema share, and kept as received.

use std::borrow::Cow;
use std::sync::LazyLock;

use regex::Regex;
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Serialize};

/// A real calendar date, `YYYY-MM-DD`, leap days included, unanchored: the date part both the
/// instant's and the calendar date's patterns share. Every class is spelled out, so Rust and
/// ECMAScript read it alike.
macro_rules! calendar_date_pattern {
    () => {
        "(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00\
         |[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])\
         |(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))"
    };
}

pub(crate) use calendar_date_pattern;

/// The instant's pattern: a real calendar date, `T`, a time with seconds and any fraction, then
/// `Z` or an offset up to `23:59`.
const INSTANT_PATTERN: &str = concat!(
    "^",
    calendar_date_pattern!(),
    "T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?\
     (?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"
);

/// [`INSTANT_PATTERN`], compiled once for the garde check.
static INSTANT_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(INSTANT_PATTERN).expect("the instant pattern is a valid regex"));

/// An instant as a peer sent it; a handler that compares or computes parses the checked text with
/// `jiff::Timestamp`. Its garde check refuses text outside the pattern.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, garde::Validate)]
#[serde(transparent)]
#[garde(transparent)]
pub struct WireInstant(#[garde(pattern(INSTANT_REGEX))] String);

impl WireInstant {
    /// The text as received.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl JsonSchema for WireInstant {
    fn schema_name() -> Cow<'static, str> {
        "WireInstant".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "description": "An RFC 3339 instant with its offset, as a peer sent it.",
            "type": "string",
            "pattern": INSTANT_PATTERN,
        })
    }
}
