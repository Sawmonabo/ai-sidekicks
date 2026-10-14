//! Reading a stored column into a typed value: TEXT through a parse or as a JSON object, a rowid as
//! unsigned, an integer as a safe one, the failure kept as the read's cause; and a closed-set word
//! written as the same spelling a read takes back.

use std::error::Error;

use rusqlite::Row;
use rusqlite::types::Type;
use serde::Serialize;
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
/// [`text_column`] does.
pub(crate) fn json_object_column(
    row: &Row<'_>,
    index: usize,
) -> rusqlite::Result<Map<String, Value>> {
    text_column(row, index, |text| serde_json::from_str(&text))
}

/// A word of a closed set, read by its serde spelling; fails for text that names no member.
pub(crate) fn closed_word<Word: DeserializeOwned>(text: String) -> Result<Word, serde_json::Error> {
    serde_json::from_value(Value::String(text))
}

/// A word of a closed set as its serde spelling, the text [`closed_word`] reads back.
pub(crate) fn closed_word_text(word: &impl Serialize) -> String {
    serde_json::to_value(word)
        .and_then(serde_json::from_value)
        .expect("a closed-set word serializes as a string")
}

/// A safe integer as SQLite stores it.
pub(crate) fn stored_integer<const MIN: u64>(value: SafeInt<MIN>) -> i64 {
    i64::try_from(value.get()).expect("a safe integer fits SQLite's INTEGER")
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
