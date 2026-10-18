//! Recovery: the start's checks, damaged history, projection rebuilds and the database file's
//! repair.

pub mod database_file;
pub(crate) mod session_write_refusal;
pub(crate) mod status;
