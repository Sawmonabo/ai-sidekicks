//! The database: SQLite connections, the one writer and its batches, statements, checkpoints, and
//! reading stored columns as typed values.

pub(crate) mod checkpoint;
pub(crate) mod connection;
pub(crate) mod sql_list;
pub(crate) mod statement;
pub(crate) mod stored_column;
