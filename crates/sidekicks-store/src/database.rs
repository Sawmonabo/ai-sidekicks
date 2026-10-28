//! The database: its schema, SQLite connections, the one writer and its batches, statements,
//! checkpoints, reads scoped to every session or one, reading stored columns as typed values, the
//! paths of the files SQLite keeps beside the database file, and the record of damage to the file.

pub(crate) mod checkpoint;
pub mod connection;
pub mod damage;
pub mod schema;
pub mod session_scope;
pub mod sql_list;
pub mod statement;
pub mod stored_column;
pub mod wal_truncation;
pub mod writer;

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// `database_path` with `suffix` added to its file name: `daemon.db` becomes `daemon.db-wal`.
pub fn sibling_path(database_path: &Path, suffix: &str) -> PathBuf {
    let mut path = OsString::from(database_path.as_os_str());
    path.push(suffix);
    PathBuf::from(path)
}
