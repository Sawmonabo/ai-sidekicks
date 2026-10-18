//! The Windows side of the interface.

pub(crate) mod allocator;
pub(crate) mod askpass;
pub(crate) mod caller_process;
pub(crate) mod child_command;
pub(crate) mod command_argument_limit;
pub(crate) mod disk;
pub(crate) mod entry_identity;
pub(crate) mod error_codes;
pub(crate) mod file_facts;
pub(crate) mod file_information;
pub(crate) mod file_system;
pub(crate) mod login_shell;
pub(crate) mod machine_name;
#[cfg(any(test, feature = "test-support"))]
pub(crate) mod measurement;
pub(crate) mod memory;
pub(crate) mod private_folder;
pub(crate) mod processes;
pub(crate) mod real_path;
pub(crate) mod run_folder;
pub(crate) mod shell_start;
pub(crate) mod socket_listener;
pub(crate) mod socket_path;
pub(crate) mod terminal;
pub(crate) mod wake_watch;
pub(crate) mod wall_clock_timer;
pub(crate) mod xdg_data_folders;
