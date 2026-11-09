//! Readers for untrusted values from a provider, a stored row or the wire: the sites that keep a
//! JSON value as a `Value` rather than reading it into a typed struct, and the text members a
//! tolerant read leaves optional.

use serde_json::{Map, Value};
use sidekicks_contracts::wire::integer::MAX_SAFE_INTEGER;
use sidekicks_contracts::wire::text::NonEmptyText;

/// Whether `text` is one or more ASCII digits alone, with no sign, space or point.
pub(crate) fn is_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// `text` when it has at least one character; `None` for an absent or empty one.
pub(crate) fn filter_non_empty<Text: AsRef<str>>(text: Option<Text>) -> Option<Text> {
    text.filter(|text| !text.as_ref().is_empty())
}

/// The string at `key` in `source` when it has at least one character; `None` for anything else.
pub fn read_non_empty_string<'source>(
    source: &'source Map<String, Value>,
    key: &str,
) -> Option<&'source str> {
    source.get(key)?.as_str().filter(|text| !text.is_empty())
}

/// The string at `key` in `source` as the contract's non-empty text when it has at least one
/// character; `None` for anything else.
pub(crate) fn read_non_empty_text(source: &Map<String, Value>, key: &str) -> Option<NonEmptyText> {
    read_non_empty_string(source, key).and_then(|text| NonEmptyText::new(text.to_owned()))
}

/// The member at `key` in `source` unless it is absent or `null`, as JavaScript's `??` reads it.
pub(crate) fn read_present_member<'source>(
    source: &'source Map<String, Value>,
    key: &str,
) -> Option<&'source Value> {
    source.get(key).filter(|member| !member.is_null())
}

/// The count at `key` in `source`: a whole number from 0 to 2^53 − 1 as JavaScript's
/// `Number.isInteger` reads one, so `5.0` and `1e3` count too; `None` for anything else.
#[expect(
    clippy::cast_precision_loss,
    reason = "2^53 - 1 is a whole number an f64 holds exactly"
)]
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "the number is whole and within 0 to 2^53 - 1, so the cast is exact"
)]
pub(crate) fn read_count(source: &Map<String, Value>, key: &str) -> Option<u64> {
    let number = source.get(key)?.as_number()?;
    if let Some(count) = number.as_u64() {
        return (count <= MAX_SAFE_INTEGER).then_some(count);
    }
    let value = number.as_f64()?;
    (value >= 0.0 && value.fract() == 0.0 && value <= MAX_SAFE_INTEGER as f64)
        .then_some(value as u64)
}
