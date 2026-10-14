//! A session's event log: the append lock, inserting a row, reading the log, publishing what
//! committed, and the version and skipped ranges its reads share.

pub(crate) mod append_lock;
pub(crate) mod followers;
pub(crate) mod insert;
pub(crate) mod read;
pub(crate) mod skipped_ranges;
pub(crate) mod version;
