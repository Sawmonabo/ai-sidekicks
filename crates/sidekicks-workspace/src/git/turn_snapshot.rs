//! Turn snapshots: the commit a turn's end records of the checkout's project state, the capture
//! folder it is written into, the kept index later captures stage into, its ref names, what the
//! capture logs, and what pruning a run's snapshots reads.

pub(crate) mod capture;
pub(crate) mod capture_folder;
pub(crate) mod capture_steps;
pub mod diagnostics;
pub(crate) mod kept_index;
pub(crate) mod refs;
pub mod retention;
pub mod service;
