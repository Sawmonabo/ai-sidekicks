//! A once-only hand of a row: a time column the one caller that takes the hand sets, so a second
//! caller finds it taken, and that a hand which failed before it went out clears again.

use std::borrow::Cow;

use crate::database::statement::{
    DATABASE_NOW_SQL, StatementBindings, WriteStatement, text_binding,
};
use crate::database::writer::{DatabaseWriter, WriteError};

/// The time column of `table` that marks one hand of the row its `key_column` names.
#[derive(Clone, Copy, Debug)]
pub struct HandedMark {
    /// The table holding the rows.
    pub table: &'static str,
    /// The column that names a row.
    pub key_column: &'static str,
    /// The time column a hand sets; `NULL` while the hand is not taken.
    pub mark_column: &'static str,
}

impl HandedMark {
    /// Takes the hand of the row `key` names through `writer`: true for the one caller whose write
    /// set the mark, false once another caller took it and for a key no row holds. Fails as the
    /// write fails.
    pub async fn claim(&self, writer: &DatabaseWriter, key: &str) -> Result<bool, WriteError> {
        let Self {
            table,
            key_column,
            mark_column,
        } = self;
        let claim = WriteStatement {
            sql: Cow::Owned(format!(
                "UPDATE {table} SET {mark_column} = {DATABASE_NOW_SQL}
                  WHERE {key_column} = @key AND {mark_column} IS NULL"
            )),
            bindings: StatementBindings::Named(vec![text_binding("@key", key)]),
            expected_row_count: Some(1),
        };
        match writer.write(vec![claim]).await {
            Ok(_results) => Ok(true),
            Err(refused) if refused.refused_statement_index().is_some() => Ok(false),
            Err(failure) => Err(failure),
        }
    }

    /// Gives back the hand of the row `key` names through `writer`, so the next caller takes it.
    /// Fails as the write fails.
    pub async fn release(&self, writer: &DatabaseWriter, key: &str) -> Result<(), WriteError> {
        let Self {
            table,
            key_column,
            mark_column,
        } = self;
        let release = WriteStatement {
            sql: Cow::Owned(format!(
                "UPDATE {table} SET {mark_column} = NULL WHERE {key_column} = @key"
            )),
            bindings: StatementBindings::Named(vec![text_binding("@key", key)]),
            expected_row_count: None,
        };
        writer.write(vec![release]).await.map(drop)
    }
}
