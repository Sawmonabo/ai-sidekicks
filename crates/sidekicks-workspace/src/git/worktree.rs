//! Worktrees: the checkouts a session works in beside its repository. Here are their tables and
//! rows, events and refusals; the service that records, retires and sweeps them; the setup card a
//! new tree runs; the one tree walk that copies setup files and kept trees, with its progress; the
//! uncommitted work carried into a new tree; the claims a kept copy's put-back checks; the
//! switcher's status read and the ordered branch list; the background fetch that keeps their
//! figures current; git's reads of trees and branches, and what a removal would lose; the index's
//! staged change checked out on its own; the discards a crash cut short; who stands and runs in
//! each folder; the watch of each working folder; and the folder reads and flushes their services
//! share.

pub(crate) mod branch_list;
pub(crate) mod carry;
pub(crate) mod claims;
pub(crate) mod copy;
pub(crate) mod errors;
pub(crate) mod event_emitter;
pub(crate) mod fetch;
pub(crate) mod flush;
pub(crate) mod folder_names;
pub(crate) mod occupancy;
pub(crate) mod projector;
pub(crate) mod reads;
pub(crate) mod risks;
pub(crate) mod rows;
pub(crate) mod schema;
pub(crate) mod service;
pub(crate) mod setup;
pub(crate) mod staged_changes;
pub(crate) mod status;
#[cfg(test)]
pub(crate) mod test_rows;
pub(crate) mod unfinished_discards;
pub(crate) mod watch;
