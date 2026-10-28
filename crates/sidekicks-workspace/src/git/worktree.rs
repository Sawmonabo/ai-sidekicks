//! Worktrees: the checkouts a session works in beside its repository. Here are their tables and
//! rows, events and refusals; the service that records, retires and sweeps them; the setup
//! card a new tree runs; the copy a retired tree is kept as and the stale records a removal
//! clears; the one tree walk that copies setup files and kept trees, with its
//! progress; the uncommitted work carried into a new tree; the claims a kept copy's put-back
//! checks; the switcher's status read and the ordered branch list; the background fetch that keeps
//! their figures current; git's reads of trees and branches, and what a removal would lose; the
//! index's staged change checked out on its own; the discards a crash cut short; who stands and
//! runs in each folder; the watch of each working folder; how a tree and its branch are named;
//! the owners whose processes a removal ends; and the folder reads and flushes their services
//! share.

pub mod branch_list;
pub(crate) mod carry;
pub(crate) mod claims;
pub(crate) mod copy;
pub mod errors;
pub mod event_emitter;
pub mod fetch;
pub(crate) mod flush;
pub(crate) mod folder_names;
pub(crate) mod kept_copy;
pub mod naming;
pub mod occupancy;
pub(crate) mod projector;
pub(crate) mod reads;
pub mod removal;
pub(crate) mod risks;
pub(crate) mod rows;
pub mod schema;
pub mod service;
pub mod setup;
pub mod staged_changes;
pub(crate) mod stale_record;
pub(crate) mod status;
#[cfg(any(test, feature = "test-support"))]
pub mod test_rows;
pub mod unfinished_discards;
pub mod watch;
