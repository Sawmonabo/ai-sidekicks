//! A session's event log: the append lock, the appender daemon-authored events go through,
//! inserting a row, reading the log, publishing what committed, the sessions a follower hands to
//! its own task, and the version and skipped ranges its reads share.

pub(crate) mod append_lock;
pub(crate) mod appender;
pub(crate) mod followers;
pub(crate) mod insert;
pub(crate) mod pending;
pub(crate) mod read;
pub(crate) mod skipped_ranges;
pub(crate) mod version;
