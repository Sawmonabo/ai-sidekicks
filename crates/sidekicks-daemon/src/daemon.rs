//! The daemon's own lifecycle: start and stop, the start as its own responsible process, the data
//! folder's hold, its status and process tree, its service log and its one scheduler, the machine
//! it runs on and the methods that report on it.

pub(crate) mod already_running_error;
pub(crate) mod app_diagnostic_methods;
pub(crate) mod artifact_methods;
pub(crate) mod backup;
pub(crate) mod config_methods;
pub(crate) mod configuration;
pub mod crash;
pub(crate) mod data_folder_lock;
pub(crate) mod lifecycle_methods;
pub(crate) mod login_shell_environment;
pub(crate) mod machine;
pub(crate) mod own_root;
pub(crate) mod panic_hook;
pub(crate) mod process_tree_usage;
pub(crate) mod repairing_socket;
pub(crate) mod retention_methods;
pub(crate) mod run_folder;
pub mod scheduler;
pub mod service_log;
pub(crate) mod start;
pub(crate) mod start_stopped_error;
pub(crate) mod status_methods;
pub(crate) mod stop_drain;
