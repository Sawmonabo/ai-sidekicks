//! A calendar date a peer sends: ISO 8601 `YYYY-MM-DD`, a real date, checked by one pattern that
//! the garde check and the JSON Schema share, and kept as received.

use std::borrow::Cow;
use std::sync::LazyLock;

use regex::Regex;
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Serialize};

use crate::wire::instant::calendar_date_pattern;

/// The date's pattern: a real calendar date, leap days included, the instant's date part.
const DATE_PATTERN: &str = concat!("^", calendar_date_pattern!(), "$");

/// [`DATE_PATTERN`], compiled once for the garde check.
static DATE_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(DATE_PATTERN).expect("the date pattern is a valid regex"));

/// A calendar date as a peer sent it. Its garde check refuses text outside the pattern.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, garde::Validate)]
#[serde(transparent)]
#[garde(transparent)]
pub struct WireDate(#[garde(pattern(DATE_REGEX))] String);

impl WireDate {
    /// The text as received.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl JsonSchema for WireDate {
    fn schema_name() -> Cow<'static, str> {
        "WireDate".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "description": "An ISO 8601 calendar date, `YYYY-MM-DD`, as a peer sent it.",
            "type": "string",
            "pattern": DATE_PATTERN,
        })
    }
}
