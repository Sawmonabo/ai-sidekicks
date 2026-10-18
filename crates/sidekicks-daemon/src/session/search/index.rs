//! The search index's rows: how a stored row maps to an index key, how rows are read for it, and
//! the outbox that feeds it.

pub(crate) mod columns;
pub(crate) mod outbox;
pub(crate) mod rows;
