//! Turn snapshots: the commit a turn's end records of the checkout's project state, its ref names,
//! what the capture logs, and what pruning a run's snapshots reads.

pub(crate) mod capture;
pub(crate) mod capture_steps;
pub mod diagnostics;
pub(crate) mod refs;
pub mod retention;
pub mod service;
