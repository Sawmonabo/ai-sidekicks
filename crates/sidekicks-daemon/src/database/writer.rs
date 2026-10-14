//! The database writer: every write the daemon makes goes through it to the one read-write
//! connection, which a thread of its own holds.

pub(crate) mod messages;
