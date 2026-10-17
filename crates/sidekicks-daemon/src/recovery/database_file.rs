//! The database file's heal: the newest backup a repair reads from, and the watch that stops a
//! recovery whose shells have stalled.

pub(crate) mod newest_backup;
pub(crate) mod stall_watch;
