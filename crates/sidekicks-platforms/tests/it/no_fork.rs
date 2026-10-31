//! Whether a terminal's start forks this process, counted by a fork handler, which is process-wide,
//! so the count is this test's alone in a process of its own.

use std::os::unix::process::CommandExt as _;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

use sidekicks_platforms::{ShellStartConfirmation, TerminalStart, start_terminal};

/// The forks this process made since the handler was registered.
static FORKS: AtomicUsize = AtomicUsize::new(0);

/// The fork handler run in this process after each fork.
extern "C" fn count_fork() {
    FORKS.fetch_add(1, Ordering::SeqCst);
}

// Fails when a terminal's start forks, which in the daemon's threaded process runs the system's
// fork handlers in the child, where they can abort it. The control's `pre_exec` makes std fork, so
// the counter is seen to count. Mutation: start the terminal's program through a `Command` with any
// `pre_exec`.
#[test]
#[expect(
    unsafe_code,
    reason = "registering a fork handler and a `pre_exec` closure are C interfaces"
)]
fn a_terminal_starts_its_program_with_no_fork() {
    // SAFETY: the handler only adds to an atomic, which is safe in the forking process.
    let registered =
        unsafe { libc::pthread_atfork(None, Some(count_fork as unsafe extern "C" fn()), None) };
    assert_eq!(registered, 0, "the fork handler is registered");
    let mut control = Command::new("/usr/bin/true");
    // SAFETY: the closure does nothing, which is safe in a forked child.
    unsafe {
        control.pre_exec(|| Ok(()));
    }
    control.status().expect("the control runs");
    assert_eq!(
        FORKS.load(Ordering::SeqCst),
        1,
        "the control's fork is counted"
    );

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

    assert_eq!(
        FORKS.load(Ordering::SeqCst),
        1,
        "the terminal's start forked"
    );
}
