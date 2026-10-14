//! All operating-system code behind one interface the other crates call: the interface's shared
//! types, a module per platform supplying the running system's implementation (`macos`, `linux`,
//! `windows`, and `posix` for what the first two share), and the `path` module, which reads a path
//! by either system's rules on every system.
#![expect(
    unsafe_code,
    reason = "the terminal's window size, console and library-search calls, the shell start's \
              signal and console-handler calls, the parent check `scutil`'s child runs in \
              `pre_exec`, the Windows host-name, free-room and entry-identity calls, the Windows \
              replacing rename's `MoveFileExW`, the macOS parent-process read, the measurement \
              tests' footprint read on macOS, and the power notifications and wall-clock timers \
              of macOS and Windows are C interfaces"
)]

mod atomic_replace;
mod entry_identity;
mod folder_place;
#[cfg(any(test, feature = "test-support"))]
mod footprint;
#[cfg(target_os = "linux")]
mod linux;
mod machine_name;
#[cfg(target_os = "macos")]
mod macos;
mod path;
#[cfg(unix)]
mod posix;
mod shell_start;
mod socket_path;
mod spawner;
mod terminal;
mod wake_watch;
#[cfg(target_os = "windows")]
mod windows;

pub use atomic_replace::{ReplaceFileError, replace_file_atomically};
pub use entry_identity::{EntryIdentity, IdentifiedEntry, NotAnEntryIdentity};
pub use folder_place::FolderPlace;
#[cfg(any(test, feature = "test-support"))]
pub use footprint::ProcessFootprint;
#[cfg(all(target_os = "linux", any(test, feature = "test-support")))]
pub use linux::process_footprint;
#[cfg(target_os = "linux")]
pub use linux::{SHOULD_MEMORY_MAP_READS, folder_place, machine_name, windows_drive_mounts};
#[cfg(target_os = "linux")]
pub use linux::{read_command_argument_limit, read_parent_process_id};
#[cfg(target_os = "linux")]
pub use linux::{wake_watch::WakeWatch, wall_clock_timer::WallClockTimer};
pub use machine_name::MachineNameError;
#[cfg(all(target_os = "macos", any(test, feature = "test-support")))]
pub use macos::process_footprint;
#[cfg(target_os = "macos")]
pub use macos::{SHOULD_MEMORY_MAP_READS, folder_place, machine_name, windows_drive_mounts};
#[cfg(target_os = "macos")]
pub use macos::{read_command_argument_limit, read_parent_process_id};
#[cfg(target_os = "macos")]
pub use macos::{wake_watch::WakeWatch, wall_clock_timer::WallClockTimer};
pub use path::resolution::{resolve_path, resolve_path_against};
pub use path::rules::PathRules;
#[cfg(unix)]
pub use posix::askpass::askpass_listener;
#[cfg(unix)]
pub use posix::caller_process::read_peer_process_id;
#[cfg(unix)]
pub use posix::disk::{
    flush_file, flush_folder, flush_open_file, read_exact_at, volume_free_bytes,
};
#[cfg(unix)]
pub use posix::entry_identity::entry_identity;
#[cfg(unix)]
pub use posix::error_codes::{
    is_hard_link_unsupported, is_held_file_error, is_out_of_open_files, is_resource_busy,
};
#[cfg(all(unix, any(test, feature = "test-support")))]
pub use posix::file_system::UnremovableFile;
#[cfg(unix)]
pub use posix::file_system::{
    CAN_RENAME_REPLACE_EMPTY_FOLDER, create_new_file, remove_tree, rename_replacing,
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
pub use posix::socket_path::check_socket_path;
#[cfg(unix)]
pub use posix::terminal::{
    TerminalWatch, child_process_id, end_process_tree, exit_signal, read_console, release_terminal,
    restrict_library_search, run_console_helper, run_terminal_loop, send_console_break,
    send_signal, terminal_ending_route, terminal_options, terminal_signal_route,
};
#[cfg(all(unix, any(test, feature = "test-support")))]
pub use posix::terminal::{abnormal_exit, echo_program, pass_through_start, waiting_printer};
#[cfg(all(unix, any(test, feature = "test-support")))]
pub use posix::uptime::uptime_line;
pub use shell_start::{ShellStart, ShellStartError};
pub use socket_path::SocketPathRefused;
pub use spawner::Spawner;
#[cfg(any(test, feature = "test-support"))]
pub use terminal::{AbnormalExit, TestProgram};
pub use terminal::{
    ConsoleReading, HELPER_PROGRAM_TIME_LIMIT, ProcessTreeEnd, TerminalSignal, TerminalSignalRoute,
    TerminalWake, TerminalWaker,
};
pub use wake_watch::WakeWatchError;
#[cfg(target_os = "windows")]
pub use windows::askpass::askpass_listener;
#[cfg(target_os = "windows")]
pub use windows::caller_process::{read_parent_process_id, read_peer_process_id};
#[cfg(target_os = "windows")]
pub use windows::command_argument_limit::read_command_argument_limit;
#[cfg(target_os = "windows")]
pub use windows::disk::{
    FlushFailure, SHOULD_MEMORY_MAP_READS, flush_file, flush_folder, flush_open_file, folder_place,
    read_exact_at, volume_free_bytes, windows_drive_mounts,
};
#[cfg(target_os = "windows")]
pub use windows::entry_identity::entry_identity;
#[cfg(target_os = "windows")]
pub use windows::error_codes::{
    is_hard_link_unsupported, is_held_file_error, is_out_of_open_files, is_resource_busy,
};
#[cfg(all(target_os = "windows", any(test, feature = "test-support")))]
pub use windows::file_system::UnremovableFile;
#[cfg(target_os = "windows")]
pub use windows::file_system::{
    CAN_RENAME_REPLACE_EMPTY_FOLDER, create_new_file, remove_tree, rename_replacing,
};
#[cfg(target_os = "windows")]
pub use windows::login_shell::login_shell;
#[cfg(target_os = "windows")]
pub use windows::machine_name::machine_name;
#[cfg(all(target_os = "windows", any(test, feature = "test-support")))]
pub use windows::measurement::{process_footprint, uptime_line};
#[cfg(target_os = "windows")]
pub use windows::private_folder::create_private_folder;
#[cfg(target_os = "windows")]
pub use windows::real_path::real_path;
#[cfg(target_os = "windows")]
pub use windows::shell_start::{
    LOGIN_SHELL_ARGUMENTS, arm_parent_death, default_shell, prepare_shell_start, start_program,
};
#[cfg(target_os = "windows")]
pub use windows::socket_path::check_socket_path;
#[cfg(target_os = "windows")]
pub use windows::terminal::{
    TerminalWatch, child_process_id, end_process_tree, exit_signal, read_console, release_terminal,
    restrict_library_search, run_console_helper, run_terminal_loop, send_console_break,
    send_signal, terminal_ending_route, terminal_options, terminal_signal_route,
};
#[cfg(all(target_os = "windows", any(test, feature = "test-support")))]
pub use windows::terminal::{abnormal_exit, echo_program, pass_through_start, waiting_printer};
#[cfg(target_os = "windows")]
pub use windows::{wake_watch::WakeWatch, wall_clock_timer::WallClockTimer};
