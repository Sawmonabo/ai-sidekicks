//! All operating-system code behind one interface the other crates call, with one module per
//! platform.
#![expect(
    unsafe_code,
    reason = "the terminal's window size, console and library-search calls are C interfaces"
)]

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(unix)]
mod posix;
mod spawner;
mod terminal;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(unix)]
pub use posix::{
    TerminalWatch, child_process_id, end_process_tree, exit_signal, read_console, release_terminal,
    restrict_library_search, run_console_helper, run_terminal_loop, send_console_break,
    send_signal, terminal_ending_route, terminal_options, terminal_signal_route,
};
#[cfg(all(unix, any(test, feature = "test-support")))]
pub use posix::{abnormal_exit, echo_program, pass_through_start, waiting_printer};
pub use spawner::Spawner;
#[cfg(any(test, feature = "test-support"))]
pub use terminal::{AbnormalExit, TestProgram};
pub use terminal::{
    ConsoleReading, HELPER_PROGRAM_TIME_LIMIT, ProcessTreeEnd, TerminalSignal, TerminalSignalRoute,
    TerminalWake, TerminalWaker,
};
#[cfg(target_os = "windows")]
pub use windows::{
    TerminalWatch, child_process_id, end_process_tree, exit_signal, read_console, release_terminal,
    restrict_library_search, run_console_helper, run_terminal_loop, send_console_break,
    send_signal, terminal_ending_route, terminal_options, terminal_signal_route,
};
#[cfg(all(target_os = "windows", any(test, feature = "test-support")))]
pub use windows::{abnormal_exit, echo_program, pass_through_start, waiting_printer};
