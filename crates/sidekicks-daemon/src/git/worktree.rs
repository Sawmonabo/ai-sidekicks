//! Worktrees: the checkouts a session works in beside its repository, their tables and rows, their
//! status, their events, their refusals, the progress of their copies, the discards a crash cut
//! short, and the folder reads and flushes their services share.

pub(crate) mod copy_progress;
pub(crate) mod errors;
pub(crate) mod event_emitter;
pub(crate) mod flush;
pub(crate) mod folder_names;
pub(crate) mod projector;
pub(crate) mod rows;
pub(crate) mod schema;
#[cfg(test)]
pub(crate) mod test_rows;
pub(crate) mod unfinished_discards;
