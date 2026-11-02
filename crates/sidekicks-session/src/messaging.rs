//! What the daemon keeps while sessions talk to each other: the exchange each pair of sessions is
//! in, the messages held for a paused session, what each session waits on and the reminders a
//! session set. Each is a plain store over its table; the services that deliver, wake and remind
//! read them, and nothing here holds a timer or a task.

use rusqlite::types::{Type, Value};
use sidekicks_ipc::registry::HandlerError;
use sidekicks_store::database::connection::read_pool::DatabaseReadError;
use sidekicks_store::database::stored_column::wrong_type_failure;
use sidekicks_store::database::writer::WriteError;

use crate::directory::lookups::SessionWriteError;

pub mod exchanges;
pub mod paused_queue;
pub mod reminders;
pub mod schema;
pub mod waits;

/// Why a messaging store did not read or keep what it was asked; a refused write keeps nothing.
#[derive(Debug, thiserror::Error)]
pub enum SessionMessagingError {
    /// A session the write names is not one this daemon holds (`session.notFound`), or the write
    /// was not kept.
    #[error(transparent)]
    Write(#[from] SessionWriteError),
    /// SQLite refused the read, or a stored value did not read.
    #[error("a read of the sessions' messaging state failed")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read's blocking task did not
    /// finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// A reminder's instant lies before the year 0000, which no stored instant can hold.
    #[error("a reminder's instant lies before the year 0000")]
    InstantOutOfRange,
}

impl From<WriteError> for SessionMessagingError {
    /// A write no session guards that was not kept.
    fn from(error: WriteError) -> Self {
        Self::Write(SessionWriteError::Write(error))
    }
}

impl From<SessionMessagingError> for HandlerError {
    /// A write refused for its session answers as that refusal does; any other failure is a
    /// fault in the daemon.
    fn from(error: SessionMessagingError) -> Self {
        match error {
            SessionMessagingError::Write(write) => write.into(),
            fault @ (SessionMessagingError::Database(_)
            | SessionMessagingError::Pool(_)
            | SessionMessagingError::InstantOutOfRange) => Self::Internal(Box::new(fault)),
        }
    }
}

// The TEXT value at `index` of a row a write's `RETURNING` answered.
fn returned_text(row: &[Value], index: usize) -> rusqlite::Result<&str> {
    match row.get(index) {
        Some(Value::Text(text)) => Ok(text),
        Some(other @ (Value::Null | Value::Integer(_) | Value::Real(_) | Value::Blob(_))) => {
            Err(wrong_type_failure(index, other))
        }
        None => Err(rusqlite::Error::InvalidColumnIndex(index)),
    }
}

// The INTEGER value at `index` of a row a write's `RETURNING` answered.
fn returned_integer(row: &[Value], index: usize) -> rusqlite::Result<i64> {
    match row.get(index) {
        Some(Value::Integer(integer)) => Ok(*integer),
        Some(other @ (Value::Null | Value::Text(_) | Value::Real(_) | Value::Blob(_))) => {
            Err(wrong_type_failure(index, other))
        }
        None => Err(rusqlite::Error::InvalidColumnIndex(index)),
    }
}

// The TEXT value at `index` of a returned row read through `parse`, its failure kept as the cause.
fn returned_parsed<Parsed, Failure>(
    row: &[Value],
    index: usize,
    parse: impl FnOnce(&str) -> Result<Parsed, Failure>,
) -> rusqlite::Result<Parsed>
where
    Failure: std::error::Error + Send + Sync + 'static,
{
    parse(returned_text(row, index)?).map_err(|failure| {
        rusqlite::Error::FromSqlConversionFailure(index, Type::Text, Box::new(failure))
    })
}
