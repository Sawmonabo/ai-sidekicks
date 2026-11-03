//! A SQL statement as the database writer takes it, and what running it reports.

use std::borrow::Cow;

use rusqlite::types::Value;
use rusqlite::{Connection, Params, Statement, params_from_iter};
use sidekicks_contracts::place::Place;

// The form every stored time is written in, as a SQL literal.
macro_rules! stored_time_form_sql {
    () => {
        "'%Y-%m-%dT%H:%M:%fZ'"
    };
}

/// The database clock's current time as a SQL expression, in the same ISO 8601 form as every
/// stored time.
pub const DATABASE_NOW_SQL: &str = concat!("strftime(", stored_time_form_sql!(), ", 'now')");

/// The database clock's time moved by `modifier`, SQLite date modifiers written as SQL (a quoted
/// literal such as `'-1 day'`, or a parameter), as a SQL expression in [`DATABASE_NOW_SQL`]'s form.
pub fn database_time_sql(modifier: &str) -> String {
    format!(
        concat!("strftime(", stored_time_form_sql!(), ", 'now', {})"),
        modifier
    )
}

/// A statement's bound values: none, positional, or named with SQLite's `@` prefix kept in each
/// name (`@session_id`).
#[derive(Clone, Debug, Default)]
pub enum StatementBindings {
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
pub fn named_bindings<'values>(
    values: &'values [(Cow<'static, str>, Value)],
) -> Vec<(&'values str, &'values Value)> {
    values
        .iter()
        .map(|(name, value)| (name.as_ref(), value))
        .collect()
}

/// A named binding of `text`, its `name` written with its `@`.
pub fn text_binding(name: &'static str, text: &str) -> (Cow<'static, str>, Value) {
    (Cow::Borrowed(name), Value::Text(text.to_owned()))
}

/// A named binding of `text`, `NULL` when it is `None`, its `name` written with its `@`.
pub fn nullable_text_binding(name: &'static str, text: Option<&str>) -> (Cow<'static, str>, Value) {
    (
        Cow::Borrowed(name),
        text.map_or(Value::Null, |text| Value::Text(text.to_owned())),
    )
}

/// A `place` column's value: the place as its wire JSON (`"windows"` or `{"distro":…}`), `NULL`
/// on macOS and Linux, so a stored place compares as text.
pub fn place_value(place: Option<&Place>) -> Value {
    Value::from(place.map(|place| {
        serde_json::to_string(place).expect("a place is a string or a one-member object")
    }))
}

/// One SQL statement for the writer to run.
#[derive(Clone, Debug)]
pub struct WriteStatement {
    /// The statement's text, also the key of its cached preparation.
    pub sql: Cow<'static, str>,
    /// The values it binds.
    pub bindings: StatementBindings,
    /// The rows the statement must change, or return when it reads; any other count refuses the
    /// write and rolls it back whole.
    pub expected_row_count: Option<usize>,
}

/// What one statement did: the rows it changed, or returned when it reads, and those rows, owned so
/// the writer's thread can send them back.
#[derive(Clone, Debug, Default)]
pub struct StatementResult {
    /// The rows changed, or returned when it reads.
    pub row_count: usize,
    /// Each returned row's values, in the statement's column order.
    pub rows: Vec<Vec<Value>>,
}

/// Runs `statement` through `connection`'s statement cache with its bindings, as the writer runs
/// each statement of a write, and answers what it did. Fails as SQLite does.
pub fn run_statement(
    connection: &Connection,
    statement: &WriteStatement,
) -> rusqlite::Result<StatementResult> {
    let mut prepared = connection.prepare_cached(&statement.sql)?;
    match &statement.bindings {
        StatementBindings::None => run_bound(&mut prepared, ()),
        StatementBindings::Positional(values) => run_bound(&mut prepared, params_from_iter(values)),
        StatementBindings::Named(values) => {
            run_bound(&mut prepared, named_bindings(values).as_slice())
        }
    }
}

/// Runs `prepared` with `params`: a statement that returns columns has its rows collected and
/// counted; any other reports the rows it changed.
fn run_bound(
    prepared: &mut Statement<'_>,
    params: impl Params,
) -> rusqlite::Result<StatementResult> {
    let column_count = prepared.column_count();
    if column_count == 0 {
        return Ok(StatementResult {
            row_count: prepared.execute(params)?,
            ..StatementResult::default()
        });
    }
    let mut rows = Vec::new();
    let mut returned = prepared.query(params)?;
    while let Some(row) = returned.next()? {
        rows.push(
            (0..column_count)
                .map(|column| row.get::<_, Value>(column))
                .collect::<rusqlite::Result<Vec<_>>>()?,
        );
    }
    Ok(StatementResult {
        row_count: rows.len(),
        rows,
    })
}
