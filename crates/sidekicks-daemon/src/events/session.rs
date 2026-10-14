//! A session's event log: inserting a row, reading the log, and the version and skipped ranges
//! its reads share.

pub(crate) mod insert;
pub(crate) mod skipped_ranges;
pub(crate) mod version;
