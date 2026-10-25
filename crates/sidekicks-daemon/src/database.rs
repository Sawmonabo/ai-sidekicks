//! The database: its schema, SQLite connections, the one writer and its batches, statements,
//! checkpoints, reads scoped to every session or one, and reading stored columns as typed values.

pub(crate) mod checkpoint;
pub mod connection;
pub mod schema;
pub(crate) mod session_scope;
pub(crate) mod sql_list;
pub(crate) mod statement;
pub(crate) mod stored_column;
pub mod writer;
