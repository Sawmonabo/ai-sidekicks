//! The wall clock's timer on Windows: a waitable timer set to an absolute due time, which the
//! system moves with any change to its clock, so it fires at its instant across sleep and clock
//! changes. A wait the system's thread pool runs on the timer tells its firing.

use std::io;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::ptr;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use windows_sys::Win32::Foundation::FALSE;
use windows_sys::Win32::System::Threading::{
    CancelWaitableTimer, CreateWaitableTimerExW, SetWaitableTimer, TIMER_ALL_ACCESS,
};

use crate::wall_clock::{WallClock, WallClockWait};
use crate::windows::handle_wait::HandleWait;

// 100-nanosecond intervals from 1601, the start of a `FILETIME`, to 1970.
const FILETIME_AT_UNIX_EPOCH: i64 = 116_444_736_000_000_000;

// The nanoseconds in one `FILETIME` interval.
const NANOSECONDS_PER_INTERVAL: u128 = 100;

// No flag: a synchronization timer, which a finished wait resets, with the default resolution.
const SYNCHRONIZATION_TIMER: u32 = 0;

/// The system's wall clock and its timer on Windows.
pub struct WallClockTimer {
    timer: Arc<OwnedHandle>,
    // Notifies at the timer's firing; set again by each arming, since a wait that notified
    // waits no more.
    wait: HandleWait,
}

impl WallClockTimer {
    /// A timer armed for no instant. Fails when the system refuses the timer or the wait on it.
    pub fn new() -> io::Result<Self> {
        // SAFETY: no attributes and no name; the access asked is the timer's own.
        let raw_timer = unsafe {
            CreateWaitableTimerExW(
                ptr::null(),
                ptr::null(),
                SYNCHRONIZATION_TIMER,
                TIMER_ALL_ACCESS,
            )
        };
        if raw_timer.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the handle was just created and is owned by nothing else.
        let timer = Arc::new(unsafe { OwnedHandle::from_raw_handle(raw_timer) });
        let wait = HandleWait::new(Arc::clone(&timer))?;
        Ok(Self { timer, wait })
    }
}

impl WallClock for WallClockTimer {
    fn arm(&self, instant: SystemTime) -> io::Result<()> {
        // Set before the timer, so the wait is in place for its signal.
        self.wait.set();
        // A positive due time is absolute, in UTC.
        let due_time = file_time(instant);
        // SAFETY: the due time is a local that lives across the call; no completion routine, and
        // the timer never wakes the machine.
        let is_set = unsafe {
            SetWaitableTimer(
                self.timer.as_raw_handle(),
                &raw const due_time,
                0,
                None,
                ptr::null(),
                FALSE,
            )
        };
        if is_set == FALSE {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    fn disarm(&self) -> io::Result<()> {
        // SAFETY: the handle is the timer's own.
        if unsafe { CancelWaitableTimer(self.timer.as_raw_handle()) } == FALSE {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    fn wait(&self) -> WallClockWait<'_> {
        Box::pin(async move {
            self.wait.notified().await;
            Ok(())
        })
    }
}

// `instant` as a `FILETIME` count, rounded up so the timer never fires before it; an instant before
// 1970 reads as 1970, which is past, and one past the count's range as its last, which never comes.
fn file_time(instant: SystemTime) -> i64 {
    let since_epoch = instant.duration_since(UNIX_EPOCH).unwrap_or_default();
    let intervals = since_epoch.as_nanos().div_ceil(NANOSECONDS_PER_INTERVAL);
    i64::try_from(intervals)
        .ok()
        .and_then(|intervals| intervals.checked_add(FILETIME_AT_UNIX_EPOCH))
        .unwrap_or(i64::MAX)
}
