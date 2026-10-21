//! Reading a stored column into a typed value: TEXT through a parse or as a JSON object, a rowid as
//! unsigned, an integer as a safe one, the failure kept as the read's cause, and a JSON one kept
//! without the stored value.

use std::error::Error;

use rusqlite::Row;
use rusqlite::types::Type;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};
use sidekicks_contracts::wire::integer::SafeInt;

/// The TEXT column at `index` read through `parse`; fails with
/// `rusqlite::Error::FromSqlConversionFailure` keeping `parse`'s failure.
pub(crate) fn text_column<Parsed, Failure>(
    row: &Row<'_>,
    index: usize,
    parse: impl FnOnce(String) -> Result<Parsed, Failure>,
) -> rusqlite::Result<Parsed>
where
    Failure: Error + Send + Sync + 'static,
{
    parse(row.get(index)?).map_err(|failure| conversion_failure(index, failure))
}

/// The nullable TEXT column at `index` read through `parse`, `None` for `NULL`; fails as
/// [`text_column`] does.
pub(crate) fn optional_text_column<Parsed, Failure>(
    row: &Row<'_>,
    index: usize,
    parse: impl FnOnce(String) -> Result<Parsed, Failure>,
) -> rusqlite::Result<Option<Parsed>>
where
    Failure: Error + Send + Sync + 'static,
{
    let text: Option<String> = row.get(index)?;
    text.map(parse)
        .transpose()
        .map_err(|failure| conversion_failure(index, failure))
}

/// The TEXT column at `index` read as a JSON object, as every stored payload is; fails as
/// [`text_column`] does, keeping a [`StoredJsonFault`].
pub(crate) fn json_object_column(
    row: &Row<'_>,
    index: usize,
) -> rusqlite::Result<Map<String, Value>> {
    text_column(row, index, |text| parse_stored_json_object(&text))
}

/// Stored `text` read as a JSON object; fails with where and how it does not read.
pub(crate) fn parse_stored_json_object(text: &str) -> Result<Map<String, Value>, StoredJsonFault> {
    serde_json::from_str(text).map_err(StoredJsonFault::from)
}

/// Where and how a stored JSON value failed to read, without the parser's message, which can
/// quote the stored value.
#[derive(Debug, thiserror::Error)]
#[error("{kind:?} fault at line {line}, column {column}")]
pub(crate) struct StoredJsonFault {
    /// Whether the text, its syntax or its data failed.
    kind: serde_json::error::Category,
    /// The line, from 1; 0 for a fault in data already parsed.
    line: usize,
    /// The column, from 1; 0 for a fault in data already parsed.
    column: usize,
}

impl From<serde_json::Error> for StoredJsonFault {
    fn from(error: serde_json::Error) -> Self {
        Self {
            kind: error.classify(),
            line: error.line(),
            column: error.column(),
        }
    }
}

/// A word of a closed set, read by its serde spelling; fails for text that names no member.
pub(crate) fn closed_word<Word: DeserializeOwned>(text: String) -> Result<Word, serde_json::Error> {
    serde_json::from_value(Value::String(text))
}

/// A rowid, or a key built from one, as unsigned: SQLite holds it signed, so a negative one fails
/// the read with `rusqlite::Error::FromSqlConversionFailure`, keeping why.
pub(crate) fn rowid_column(row: &Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let value: i64 = row.get(index)?;
    u64::try_from(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(index, Type::Integer, Box::new(error))
    })
}

/// An INTEGER that holds a safe integer from `MIN` up, such as a sequence, a place or a bound;
/// fails the read with `rusqlite::Error::FromSqlConversionFailure`, naming the value, for one
/// below `MIN` or past 2^53 − 1.
pub(crate) fn safe_int_column<const MIN: u64>(
    row: &Row<'_>,
    index: usize,
) -> rusqlite::Result<SafeInt<MIN>> {
    let value: i64 = row.get(index)?;
    u64::try_from(value)
        .ok()
        .and_then(SafeInt::new)
        .ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                index,
                Type::Integer,
                Box::new(IntegerOutsideSafeRangeError { value, min: MIN }),
            )
        })
}

/// A stored integer below the least its column allows or past 2^53 − 1, which JavaScript's
/// numbers cannot hold exactly.
#[derive(Debug, thiserror::Error)]
#[error("the stored integer {value} is outside {min}..=2^53 - 1")]
struct IntegerOutsideSafeRangeError {
    value: i64,
    min: u64,
}

fn conversion_failure(
    index: usize,
    failure: impl Error + Send + Sync + 'static,
) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(index, Type::Text, Box::new(failure))
}
