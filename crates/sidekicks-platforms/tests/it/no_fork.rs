//! Whether a terminal's start forks this process.

use std::path::Path;

use sidekicks_platforms::{ShellStartConfirmation, TerminalStart, start_terminal};

use crate::fork_count::{count_forks, forks};

// Fails when a terminal's start forks, which in the daemon's threaded process runs the system's
// fork handlers in the child, where they can abort it. Mutation: start the terminal's program
// through a `Command` with any `pre_exec`.
#[test]
fn a_terminal_starts_its_program_with_no_fork() {
    count_forks();

    let confirmation = ShellStartConfirmation::new().expect("the pair opens");
    let folder = std::env::current_dir().expect("the test runs in a folder");
    let pty = start_terminal(&TerminalStart {
        program: Path::new("/usr/bin/true"),
        arguments: &[],
        folder: &folder,
        rows: 24,
        columns: 80,
        confirmation: &confirmation,
    })
    .expect("the terminal starts");
    drop(pty);

    assert_eq!(forks(), 1, "the terminal's start forked");
}
