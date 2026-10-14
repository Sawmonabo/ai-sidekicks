//! Reading a stored TEXT column into a typed value, the parse failure kept as the read's cause.

use std::error::Error;

use rusqlite::Row;
use rusqlite::types::Type;
use serde::de::DeserializeOwned;
use serde_json::Value;

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

/// A word of a closed set, read by its serde spelling; fails for text that names no member.
pub(crate) fn closed_word<Word: DeserializeOwned>(text: String) -> Result<Word, serde_json::Error> {
    serde_json::from_value(Value::String(text))
}

fn conversion_failure(
    index: usize,
    failure: impl Error + Send + Sync + 'static,
) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(index, Type::Text, Box::new(failure))
}
