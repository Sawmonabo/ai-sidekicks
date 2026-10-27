//! Session search: the search box's query, its pages and cursors, the hit lines, the index the
//! search reads, and the `@` search of a session's working-folder files.

pub(crate) mod cursor;
pub mod files;
pub(crate) mod hits;
pub mod index;
pub(crate) mod marked_line;
pub(crate) mod merging;
pub(crate) mod page;
pub(crate) mod query;
pub(crate) mod rank_fusion;
pub(crate) mod rowid_floors;
pub(crate) mod service;
pub(crate) mod snapshots;
pub(crate) mod transcript;
