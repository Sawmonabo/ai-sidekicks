//! A SQL statement as the database writer takes it, and what running it reports.

use std::borrow::Cow;

use rusqlite::types::Value;
use sidekicks_contracts::place::Place;

/// The database clock's current time as a SQL expression, in the same ISO 8601 form as every
/// stored time.
pub(crate) const DATABASE_NOW_SQL: &str = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/// A statement's bound values: none, positional, or named with SQLite's `@` prefix kept in each
/// name (`@session_id`).
#[derive(Clone, Debug, Default)]
pub(crate) enum StatementBindings {
    /// The statement binds nothing.
    #[default]
    None,
    /// Values bound to `?` in order.
    Positional(Vec<Value>),
    /// Values bound by name, each name written with its `@`.
    Named(Vec<(Cow<'static, str>, Value)>),
}

/// Named bindings in the form rusqlite binds them, each name with its `@`, for a statement run
/// outside the writer as the writer runs it.
pub(crate) fn named_bindings<'values>(
    values: &'values [(Cow<'static, str>, Value)],
) -> Vec<(&'values str, &'values Value)> {
    values
        .iter()
        .map(|(name, value)| (name.as_ref(), value))
        .collect()
}

/// A named binding of `text`, its `name` written with its `@`.
pub(crate) fn text_binding(name: &'static str, text: &str) -> (Cow<'static, str>, Value) {
    (Cow::Borrowed(name), Value::Text(text.to_owned()))
}

/// A named binding of `text`, `NULL` when it is `None`, its `name` written with its `@`.
pub(crate) fn nullable_text_binding(
    name: &'static str,
    text: Option<&str>,
) -> (Cow<'static, str>, Value) {
    (
        Cow::Borrowed(name),
        text.map_or(Value::Null, |text| Value::Text(text.to_owned())),
    )
}

/// A `place` column's value: the place as its wire JSON (`"windows"` or `{"distro":…}`), `NULL` on
/// macOS and Linux, so a stored place compares as text.
pub(crate) fn place_value(place: Option<&Place>) -> Value {
    Value::from(place.map(|place| {
        serde_json::to_string(place).expect("a place is a string or a one-member object")
    }))
}

/// One SQL statement for the writer to run.
#[derive(Clone, Debug)]
pub(crate) struct WriteStatement {
    /// The statement's text, also the key of its cached preparation.
    pub(crate) sql: Cow<'static, str>,
    /// The values it binds.
    pub(crate) bindings: StatementBindings,
    /// The rows the statement must change, or return when it reads; any other count refuses the
    /// write and rolls it back whole.
    pub(crate) expected_row_count: Option<usize>,
}

/// What one statement did: the rows it changed, or returned when it reads, and those rows, owned so
/// the writer's thread can send them back.
#[derive(Clone, Debug, Default)]
pub(crate) struct StatementResult {
    /// The rows changed, or returned when it reads.
    pub(crate) row_count: usize,
    /// The names of the returned columns, in order; empty when it returns no rows.
    pub(crate) column_names: Vec<String>,
    /// Each returned row's values, in `column_names`' order.
    pub(crate) rows: Vec<Vec<Value>>,
}
