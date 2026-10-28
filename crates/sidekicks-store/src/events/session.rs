//! A session's event log: the append lock, the appender daemon-authored events go through,
//! inserting a row, reading the log, publishing what committed, the sessions a follower hands to
//! its own task, and the version and skipped ranges its reads share.

pub mod append_lock;
pub mod appender;
pub mod followers;
pub mod insert;
pub mod pending;
pub mod read;
pub mod skipped_ranges;
pub mod version;
