//! The daemon's connections to its database: the setup every one of them holds, and a reading
//! service's one read-only connection.

pub(crate) mod reader;
pub(crate) mod setup;
