//! The machine's wakes from sleep on Windows: `PowerRegisterSuspendResumeNotification` with a
//! callback, which needs no window, heard at `PBT_APMRESUMEAUTOMATIC`, the event every resume sends
//! whether or not a person is present.

use std::ffi::c_void;
use std::io;
use std::ptr;

use tokio::sync::Notify;
use windows_sys::Win32::Foundation::ERROR_SUCCESS;
use windows_sys::Win32::System::Power::{
    DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS, HPOWERNOTIFY, PowerRegisterSuspendResumeNotification,
    PowerUnregisterSuspendResumeNotification,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{DEVICE_NOTIFY_CALLBACK, PBT_APMRESUMEAUTOMATIC};

use crate::wake_watch::WakeWatchError;

// What announces the wakes, as an error names it.
const SOURCE_NAME: &str = "PowerRegisterSuspendResumeNotification";

// The wakes the callback tells. Process-wide, since the system documents no wait for a callback
// under way when a registration ends, so nothing the callback reads may ever be freed; the service
// keeps one watch.
static WAKES: Notify = Notify::const_new();

/// The machine's wakes from sleep, heard from the system's suspend and resume notifications.
pub struct WakeWatch {
    registration: HPOWERNOTIFY,
    // Kept for the registration's life, since the system documents no copy of it.
    _subscription: Box<DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS>,
}

// SAFETY: the subscription is read only by the system, and the registration is ended by the drop
// alone.
unsafe impl Send for WakeWatch {}

impl WakeWatch {
    /// Starts hearing the machine's wakes. Fails with [`WakeWatchError`] when the system refuses
    /// the registration.
    #[expect(
        clippy::unused_async,
        reason = "the interface is async because Linux's start connects to the system bus"
    )]
    pub async fn start() -> Result<Self, WakeWatchError> {
        let subscription = Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
            Callback: Some(on_power_event),
            Context: ptr::null_mut(),
        });
        let mut registration: *mut c_void = ptr::null_mut();
        // SAFETY: the subscription lives in a box the watch keeps until the drop ends the
        // registration; the out pointer is this frame's local.
        let outcome = unsafe {
            PowerRegisterSuspendResumeNotification(
                DEVICE_NOTIFY_CALLBACK,
                ptr::from_ref(&*subscription).cast_mut().cast(),
                &raw mut registration,
            )
        };
        if outcome != ERROR_SUCCESS {
            return Err(WakeWatchError {
                source_name: SOURCE_NAME,
                source: io::Error::from_raw_os_error(outcome.cast_signed()).into(),
            });
        }
        Ok(Self {
            registration: registration.addr().cast_signed(),
            _subscription: subscription,
        })
    }

    /// Waits for the machine's next wake; wakes that came while no one waited count as one.
    /// Cancel-safe, and never fails on Windows.
    pub async fn next_wake(&mut self) -> Result<(), WakeWatchError> {
        WAKES.notified().await;
        Ok(())
    }
}

impl Drop for WakeWatch {
    fn drop(&mut self) {
        // SAFETY: the registration is the watch's own and is ended once.
        let outcome = unsafe { PowerUnregisterSuspendResumeNotification(self.registration) };
        if outcome != ERROR_SUCCESS {
            tracing::warn!(
                error = &io::Error::from_raw_os_error(outcome.cast_signed())
                    as &(dyn std::error::Error + 'static),
                "The wake notifications could not be ended"
            );
        }
    }
}

// Tells a resume to the watch; every other power event is ignored.
unsafe extern "system" fn on_power_event(
    _context: *const c_void,
    event_type: u32,
    _setting: *const c_void,
) -> u32 {
    if event_type == PBT_APMRESUMEAUTOMATIC {
        WAKES.notify_one();
    }
    ERROR_SUCCESS
}
