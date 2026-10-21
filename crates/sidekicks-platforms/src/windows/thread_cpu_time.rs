//! The calling thread's processor time on Windows.

use std::io;
use std::time::Duration;

use windows_sys::Win32::Foundation::{FALSE, FILETIME};
use windows_sys::Win32::System::Threading::{GetCurrentThread, GetThreadTimes};

// The 100-nanosecond intervals `GetThreadTimes` counts in one second.
const INTERVALS_PER_SECOND: u64 = 10_000_000;

// The nanoseconds in one interval.
const NANOSECONDS_PER_INTERVAL: u32 = 100;

/// The processor time the calling thread has used since it began, its kernel and user time from
/// `GetThreadTimes`. Fails with the system's error when Windows refuses the read.
pub fn thread_cpu_time() -> io::Result<Duration> {
    let mut times = [FILETIME::default(); 4];
    let [creation, exit, kernel, user] = &mut times;
    // SAFETY: the pseudo handle names the calling thread and needs no closing; each pointer names
    // a live `FILETIME`, the four things the call writes.
    if unsafe { GetThreadTimes(GetCurrentThread(), creation, exit, kernel, user) } == FALSE {
        return Err(io::Error::last_os_error());
    }
    let intervals = intervals_of(*kernel) + intervals_of(*user);
    let nanoseconds = u32::try_from(intervals % INTERVALS_PER_SECOND)
        .expect("the remainder of a second's intervals fits in a u32")
        * NANOSECONDS_PER_INTERVAL;
    Ok(Duration::new(intervals / INTERVALS_PER_SECOND, nanoseconds))
}

// A `FILETIME` duration as its count of 100-nanosecond intervals.
fn intervals_of(time: FILETIME) -> u64 {
    (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime)
}
