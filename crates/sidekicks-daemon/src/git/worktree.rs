//! Worktrees: the checkouts a session works in beside its repository, their tables, their status,
//! their refusals, the progress of their copies, and the folder reads and flushes their services
//! share.

pub(crate) mod copy_progress;
pub(crate) mod errors;
pub(crate) mod flush;
pub(crate) mod folder_names;
pub(crate) mod projector;
pub(crate) mod schema;
