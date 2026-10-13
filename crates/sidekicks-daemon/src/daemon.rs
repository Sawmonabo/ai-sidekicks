//! The daemon's own lifecycle: start and stop, the data folder's hold, its status and process
//! tree, its service log and its one scheduler, the machine it runs on and the methods that report
//! on it.

pub(crate) mod already_running_error;
pub(crate) mod process_tree_usage;
pub(crate) mod scheduler;
pub mod service_log;
pub(crate) mod start_stopped_error;
