//! All operating-system code behind one interface the other crates call, with one module per
//! platform.
#![expect(
    unsafe_code,
    reason = "the terminal's window size, console and library-search calls, the shell start's \
              signal and console-handler calls, the parent check `scutil`'s child runs in \
              `pre_exec`, and the Windows host-name and free-room calls are C interfaces"
)]

#[cfg(target_os = "linux")]
mod linux;
mod machine_name;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(unix)]
mod posix;
mod shell_start;
mod spawner;
mod terminal;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
pub use linux::{machine_name, windows_drive_mounts};
pub use machine_name::MachineNameError;
#[cfg(target_os = "macos")]
pub use macos::{machine_name, windows_drive_mounts};
#[cfg(unix)]
pub use posix::disk::{flush_file, flush_folder, volume_free_bytes};
#[cfg(unix)]
pub use posix::error_codes::{
    is_hard_link_unsupported, is_held_file_error, is_out_of_open_files, is_resource_busy,
};
#[cfg(unix)]
pub use posix::login_shell::login_shell;
#[cfg(unix)]
pub use posix::private_folder::create_private_folder;
#[cfg(unix)]
pub use posix::real_path::real_path;
#[cfg(unix)]
pub use posix::shell_start::{
    LOGIN_SHELL_ARGUMENTS, arm_parent_death, default_shell, prepare_shell_start, start_program,
};
#[cfg(unix)]
pub use posix::terminal::{
    TerminalWatch, child_process_id, end_process_tree, exit_signal, read_console, release_terminal,
    restrict_library_search, run_console_helper, run_terminal_loop, send_console_break,
    send_signal, terminal_ending_route, terminal_options, terminal_signal_route,
};
#[cfg(all(unix, any(test, feature = "test-support")))]
pub use posix::terminal::{abnormal_exit, echo_program, pass_through_start, waiting_printer};
pub use shell_start::{ShellStart, ShellStartError};
pub use spawner::Spawner;
#[cfg(any(test, feature = "test-support"))]
pub use terminal::{AbnormalExit, TestProgram};
pub use terminal::{
    ConsoleReading, HELPER_PROGRAM_TIME_LIMIT, ProcessTreeEnd, TerminalSignal, TerminalSignalRoute,
    TerminalWake, TerminalWaker,
};
#[cfg(target_os = "windows")]
pub use windows::disk::{
    FlushFailure, flush_file, flush_folder, volume_free_bytes, windows_drive_mounts,
};
#[cfg(target_os = "windows")]
pub use windows::error_codes::{
    is_hard_link_unsupported, is_held_file_error, is_out_of_open_files, is_resource_busy,
};
#[cfg(target_os = "windows")]
pub use windows::login_shell::login_shell;
#[cfg(target_os = "windows")]
pub use windows::machine_name::machine_name;
#[cfg(target_os = "windows")]
pub use windows::private_folder::create_private_folder;
#[cfg(target_os = "windows")]
pub use windows::real_path::real_path;
#[cfg(target_os = "windows")]
pub use windows::shell_start::{
    LOGIN_SHELL_ARGUMENTS, arm_parent_death, default_shell, prepare_shell_start, start_program,
};
#[cfg(target_os = "windows")]
pub use windows::terminal::{
    TerminalWatch, child_process_id, end_process_tree, exit_signal, read_console, release_terminal,
    restrict_library_search, run_console_helper, run_terminal_loop, send_console_break,
    send_signal, terminal_ending_route, terminal_options, terminal_signal_route,
};
#[cfg(all(target_os = "windows", any(test, feature = "test-support")))]
pub use windows::terminal::{abnormal_exit, echo_program, pass_through_start, waiting_printer};
