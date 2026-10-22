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

/// The instant the year 0000 begins, the earliest the pattern's four-digit year holds.
const YEAR_ZERO_BEGINS: jiff::Timestamp = jiff::Timestamp::constant(-62_167_219_200, 0);

/// `timestamp` in the form every stored or sent instant takes, UTC to the millisecond with three
/// fraction digits and `Z`, as `Date.prototype.toISOString` writes it; `None` before the year
/// 0000, which the four-digit year cannot write.
pub(crate) fn stored_instant_text(timestamp: jiff::Timestamp) -> Option<String> {
    (timestamp >= YEAR_ZERO_BEGINS)
        .then(|| timestamp.strftime("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

/// [`INSTANT_PATTERN`], compiled once for the garde check.
static INSTANT_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(INSTANT_PATTERN).expect("the instant pattern is a valid regex"));

/// An instant as a peer sent it; a handler that compares or computes parses the checked text with
/// `jiff::Timestamp`. Its garde check refuses text outside the pattern.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, garde::Validate)]
#[serde(transparent)]
#[garde(transparent)]
pub struct WireInstant(#[garde(pattern(INSTANT_REGEX))] String);

/// Text the instant's pattern refuses; it names no value.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("the text is not an RFC 3339 instant with its offset")]
pub struct NotAnInstant;

impl WireInstant {
    /// `timestamp` as the UTC text every stored or sent instant takes, three fraction digits and
    /// `Z`, as `Date.prototype.toISOString` writes it; `None` before the year 0000, whose text the
    /// pattern refuses.
    pub fn from_timestamp(timestamp: jiff::Timestamp) -> Option<Self> {
        stored_instant_text(timestamp).map(Self)
    }

    /// The system clock's instant in the stored form. It is left out of WebAssembly builds, the
    /// control plane's Worker and the contracts' own among them, since jiff reads the clock through
    /// std, which panics on `wasm32-unknown-unknown`.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn now() -> Self {
        Self::from_timestamp(jiff::Timestamp::now()).expect("the clock reads after year 0000")
    }

    /// The text as received.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The instant's milliseconds since the Unix epoch, as [`WireInstant::timestamp`] reads it;
    /// `None` where it does not parse, as `Date.parse` answers NaN.
    pub fn unix_millisecond(&self) -> Option<i64> {
        self.timestamp().map(jiff::Timestamp::as_millisecond)
    }

    /// The instant as a timestamp, its fraction past the ninth digit dropped since a timestamp
    /// holds nanoseconds; `None` where it does not parse or lies past the last timestamp.
    pub fn timestamp(&self) -> Option<jiff::Timestamp> {
        let instant = self.0.as_str();
        let trimmed = match instant.find('.').map(|dot| dot + 1) {
            Some(start) => {
                let digit_count = instant[start..]
                    .bytes()
                    .take_while(u8::is_ascii_digit)
                    .count();
                if digit_count > 9 {
                    format!(
                        "{}{}",
                        &instant[..start + 9],
                        &instant[start + digit_count..]
                    )
                } else {
                    instant.to_owned()
                }
            }
            None => instant.to_owned(),
        };
        trimmed.parse().ok()
    }
}

impl TryFrom<String> for WireInstant {
    type Error = NotAnInstant;

    /// Takes stored text back as an instant, refusing what the pattern refuses.
    fn try_from(text: String) -> Result<Self, Self::Error> {
        if INSTANT_REGEX.is_match(&text) {
            Ok(Self(text))
        } else {
            Err(NotAnInstant)
        }
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

#[cfg(test)]
mod tests {
    use garde::Validate;
    use rstest::rstest;

    use super::WireInstant;

    #[rstest]
    #[case::a_lower_case_t("2025-01-01t00:00:00Z", false)]
    #[case::a_lower_case_z("2025-01-01T00:00:00z", false)]
    #[case::a_space_for_t("2025-01-01 00:00:00Z", false)]
    #[case::an_offset_without_its_colon("2025-01-01T00:00:00+0100", false)]
    #[case::an_offset_past_23("2025-01-01T00:00:00+24:00", false)]
    #[case::a_leap_second("2016-12-31T23:59:60Z", false)]
    #[case::a_day_the_year_lacks("2025-02-29T00:00:00Z", false)]
    #[case::no_seconds("2025-01-01T00:00Z", false)]
    #[case::a_ten_digit_fraction("2025-01-01T00:00:00.1234567890Z", true)]
    #[case::an_offset("2024-02-29T23:59:59.5-05:30", true)]
    fn the_pattern_takes_only_rfc_3339_instants_with_an_offset(
        #[case] text: &str,
        #[case] is_instant: bool,
    ) {
        assert_eq!(WireInstant::try_from(text.to_owned()).is_ok(), is_instant);
        let received: WireInstant =
            serde_json::from_value(serde_json::Value::String(text.to_owned()))
                .expect("any string reads as a received instant before its check");
        assert_eq!(received.validate().is_ok(), is_instant);
    }

    #[rstest]
    #[case::a_clock_reading(1_791_950_706, 789_123_000, Some("2026-10-14T04:05:06.789Z"))]
    #[case::the_year_zero_begins(-62_167_219_200, 0, Some("0000-01-01T00:00:00.000Z"))]
    #[case::before_the_year_zero(-62_167_219_201, 999_000_000, None)]
    fn a_timestamp_is_written_in_the_stored_form_and_read_back_equal(
        #[case] second: i64,
        #[case] nanosecond: i32,
        #[case] written: Option<&str>,
    ) {
        let timestamp =
            jiff::Timestamp::new(second, nanosecond).expect("the case is in jiff's range");
        let instant = WireInstant::from_timestamp(timestamp);
        assert_eq!(instant.as_ref().map(WireInstant::as_str), written);
        if let Some(instant) = instant {
            assert!(instant.validate().is_ok());
            assert_eq!(
                WireInstant::try_from(instant.as_str().to_owned()),
                Ok(instant)
            );
        }
    }
}
