//! The calling thread's processor time on macOS and Linux.

use std::io;
use std::time::Duration;

use nix::time::ClockId;

/// The processor time the calling thread has used since it began, `CLOCK_THREAD_CPUTIME_ID`.
/// Fails with the system's error when the clock cannot be read.
pub fn thread_cpu_time() -> io::Result<Duration> {
    Ok(Duration::from(ClockId::CLOCK_THREAD_CPUTIME_ID.now()?))
}
