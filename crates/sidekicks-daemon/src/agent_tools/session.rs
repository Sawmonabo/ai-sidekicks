//! The handlers of the session tools that only read: `session_list`, `session_search`,
//! `session_options` and `session_read`, each taking its arguments from the tool's contract and
//! answering in that contract's result text.

pub(crate) mod list;
pub(crate) mod options;
pub(crate) mod read;
pub(crate) mod search;
