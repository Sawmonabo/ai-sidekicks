//! The wall clock's timer on Windows: a waitable timer set to an absolute due time, which the
//! system moves with any change to its clock, so it fires at its instant across sleep and clock
//! changes. A wait registered on the thread pool's wait thread tells its firing.

use std::ffi::c_void;
use std::io;
use std::mem;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::ptr;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::Notify;
use windows_sys::Win32::Foundation::{FALSE, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Threading::{
    CancelWaitableTimer, CreateWaitableTimerExW, INFINITE, RegisterWaitForSingleObject,
    SetWaitableTimer, TIMER_ALL_ACCESS, UnregisterWaitEx, WT_EXECUTEINWAITTHREAD,
};

use crate::wall_clock::{WallClock, WallClockWait};

// 100-nanosecond intervals from 1601, the start of a `FILETIME`, to 1970.
const FILETIME_AT_UNIX_EPOCH: i64 = 116_444_736_000_000_000;

// The nanoseconds in one `FILETIME` interval.
const NANOSECONDS_PER_INTERVAL: u128 = 100;

// No flag: a synchronization timer, which a finished wait resets, with the default resolution.
const SYNCHRONIZATION_TIMER: u32 = 0;

/// The system's wall clock and its timer on Windows.
pub struct WallClockTimer {
    timer: OwnedHandle,
    wait_registration: HANDLE,
    fired: Arc<Notify>,
}

// SAFETY: the wait registration is a handle the drop alone ends; the callback reads only `fired`.
unsafe impl Send for WallClockTimer {}

// SAFETY: a shared timer only sets, cancels and waits on its timer handle, which the system allows
// from any thread; the wait registration is touched by the drop alone.
unsafe impl Sync for WallClockTimer {}

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
        let timer = unsafe { OwnedHandle::from_raw_handle(raw_timer) };
        let fired = Arc::new(Notify::new());
        let mut wait_registration: HANDLE = ptr::null_mut();
        // SAFETY: the context is `fired`, which the timer keeps until the drop has ended the wait
        // and every callback in it; the callback matches `WAITORTIMERCALLBACK`.
        let is_registered = unsafe {
            RegisterWaitForSingleObject(
                &raw mut wait_registration,
                timer.as_raw_handle(),
                Some(on_fire),
                Arc::as_ptr(&fired).cast(),
                INFINITE,
                WT_EXECUTEINWAITTHREAD,
            )
        };
        if is_registered == FALSE {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            timer,
            wait_registration,
            fired,
        })
    }
}

impl WallClock for WallClockTimer {
    fn arm(&self, instant: SystemTime) -> io::Result<()> {
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
            self.fired.notified().await;
            Ok(())
        })
    }
}

impl Drop for WallClockTimer {
    fn drop(&mut self) {
        // Waits for a callback under way, so none reads `fired` once it goes; the handle closes
        // after.
        // SAFETY: the registration is the timer's own and is ended once.
        if unsafe { UnregisterWaitEx(self.wait_registration, INVALID_HANDLE_VALUE) } == FALSE {
            tracing::warn!(
                error = &io::Error::last_os_error() as &(dyn std::error::Error + 'static),
                "A wall-clock timer's wait could not be ended"
            );
            // The wait may still call back, so what it reads is kept for the process's life.
            mem::forget(Arc::clone(&self.fired));
        }
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

// Tells the waiter the timer fired.
unsafe extern "system" fn on_fire(context: *mut c_void, _is_timed_out: bool) {
    // SAFETY: the context is the timer's `fired`, alive until the drop has ended the wait.
    let fired = unsafe { &*context.cast::<Notify>() };
    fired.notify_one();
}
