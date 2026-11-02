//! A count of the forks this process makes, kept by a fork handler, which is process-wide, so a
//! test that reads it runs in a process of its own.

use std::os::unix::process::CommandExt as _;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

/// The forks this process made since the handler was registered.
static FORKS: AtomicUsize = AtomicUsize::new(0);

/// The fork handler run in this process after each fork.
extern "C" fn count_fork() {
    FORKS.fetch_add(1, Ordering::SeqCst);
}

/// Registers the fork handler, then runs a control that forks, a `Command` with a `pre_exec`, and
/// checks it is counted, so a count that stays put after it means no fork. Panics when the handler
/// cannot be registered or the control is not counted.
#[expect(
    unsafe_code,
    reason = "registering a fork handler and a `pre_exec` closure are C interfaces"
)]
pub(crate) fn count_forks() {
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
    assert_eq!(forks(), 1, "the control's fork is counted");
}

/// The forks this process made since [`count_forks`] registered the handler, its control's
/// included.
pub(crate) fn forks() -> usize {
    FORKS.load(Ordering::SeqCst)
}
