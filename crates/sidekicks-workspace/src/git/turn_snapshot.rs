//! Captures of a checkout's project state into its owner's capture folder: the commit a turn's end
//! records, the two captures around a command, the kept index those stage into, the packing that
//! copies what a capture borrows from the repository into the folder and folds its packs, the ref
//! names, what the captures log, and what pruning a run's snapshots reads.

pub mod capture;
pub mod capture_folder;
pub(crate) mod capture_steps;
pub mod command_capture;
pub mod diagnostics;
pub(crate) mod held_checkout;
pub(crate) mod kept_index;
pub mod refs;
pub mod repack;
pub mod retention;
pub mod service;
