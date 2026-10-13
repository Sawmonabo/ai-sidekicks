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
mod terminal;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(unix)]
pub use posix::{
    TerminalWaker, TerminalWatch, child_process_id, end_process_tree, exit_signal, read_console,
    resize_terminal, restrict_library_search, run_console_helper, run_terminal_loop,
    send_console_break, send_signal, terminal_ending_route, terminal_options,
    terminal_signal_route,
};
pub use terminal::{
    ConsoleReading, ProcessTreeEnd, TerminalSignal, TerminalSignalRoute, TerminalWake,
    taskkill_arguments,
};
#[cfg(target_os = "windows")]
pub use windows::{
    TerminalWaker, TerminalWatch, child_process_id, end_process_tree, exit_signal, read_console,
    resize_terminal, restrict_library_search, run_console_helper, run_terminal_loop,
    send_console_break, send_signal, terminal_ending_route, terminal_options,
    terminal_signal_route,
};
