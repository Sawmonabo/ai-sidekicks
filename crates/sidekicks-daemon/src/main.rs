//! The `sidekicks-daemon` program: the daemon itself, or the helper mode its arguments or its file
//! name select.

// Set here, not in the workspace table: rustc builds every library's unit tests as a program,
// where this lint reports each `pub` item the tests leave unused.
#![warn(dead_code_pub_in_binary)]
#![expect(
    unsafe_code,
    reason = "SQLite's shell, built into the program from its vendored source with its `main` \
              renamed, is a C function"
)]

use std::ffi::{CString, c_char, c_int};
use std::process::ExitCode;

/// The allocator every thread of the program allocates through.
#[global_allocator]
static GLOBAL_ALLOCATOR: sidekicks_platforms::GlobalAllocator =
    sidekicks_platforms::GLOBAL_ALLOCATOR;

unsafe extern "C" {
    // SQLite's shell's `main`, renamed at its build.
    fn sqlite3_shell_main(argc: c_int, argv: *mut *mut c_char) -> c_int;
}

/// Runs SQLite's shell with `arguments`, its first the program's name.
fn run_sqlite_shell(arguments: &[CString]) -> c_int {
    let mut argv = sidekicks_platforms::null_terminated_pointers(arguments);
    let argc = c_int::try_from(arguments.len()).expect("a program's arguments fit a C int");
    // SAFETY: `argv` holds `argc` pointers to NUL-terminated strings that outlive the call, then a
    // null, as C's `main` takes them; the shell may rewrite the array but writes through no string.
    unsafe { sqlite3_shell_main(argc, argv.as_mut_ptr()) }
}

fn main() -> ExitCode {
    sidekicks_daemon::program::run_daemon_program(run_sqlite_shell)
}
