//! The search index: how a stored row maps to an index key and how rows are read for it, the
//! outbox that feeds it and its tables, applying the outbox, opening or building the index, the
//! `index` mode that builds it in a child process, and the live index the daemon serves searches
//! from.

pub(crate) mod applier;
pub(crate) mod build_mode;
pub(crate) mod columns;
pub(crate) mod live;
pub(crate) mod outbox;
pub(crate) mod rebuild;
pub(crate) mod rows;
pub(crate) mod schema;
