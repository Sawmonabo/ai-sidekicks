//! The search index: how a stored row maps to an index key and how rows are read for it, the
//! outbox that feeds it and its tables, applying the outbox, and opening or building the index.

pub(crate) mod applier;
pub(crate) mod columns;
pub(crate) mod outbox;
pub(crate) mod rebuild;
pub(crate) mod rows;
pub(crate) mod schema;
