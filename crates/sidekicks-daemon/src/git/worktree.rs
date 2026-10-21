//! Worktrees: the checkouts a session works in beside its repository, their tables and rows, their
//! names, their status, their events, their refusals, what a removal would lose, the index's staged
//! change checked out on its own, the progress of their copies, the discards a crash cut short,
//! who stands and runs in each folder, the watch of each working folder, and the folder reads and
//! flushes their services share.

pub(crate) mod branch_list;
pub(crate) mod copy_progress;
pub(crate) mod errors;
pub(crate) mod event_emitter;
pub(crate) mod fetch;
pub(crate) mod flush;
pub(crate) mod folder_names;
pub(crate) mod live_session_folders;
pub(crate) mod naming;
pub(crate) mod occupancy;
pub(crate) mod projector;
pub(crate) mod reads;
pub(crate) mod risks;
pub(crate) mod rows;
pub(crate) mod schema;
pub(crate) mod staged_changes;
#[cfg(test)]
pub(crate) mod test_rows;
pub(crate) mod unfinished_discards;
pub(crate) mod watch;
