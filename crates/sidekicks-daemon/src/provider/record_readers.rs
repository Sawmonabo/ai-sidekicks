//! A reader for the sites that keep an untrusted JSON value from a provider, a stored row or the
//! wire as a `Value` rather than reading it into a typed struct.

use serde_json::{Map, Value};

/// The string at `key` in `source` when it has at least one character; `None` for anything else.
pub(crate) fn read_non_empty_string<'source>(
    source: &'source Map<String, Value>,
    key: &str,
) -> Option<&'source str> {
    source.get(key)?.as_str().filter(|text| !text.is_empty())
}
