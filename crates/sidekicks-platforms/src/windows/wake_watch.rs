//! The machine's wakes from sleep on Windows. `PowerRegisterSuspendResumeNotification` with a
//! callback, which needs no window, tells each resume from sleep or hibernation at
//! `PBT_APMRESUMEAUTOMATIC`, sent whether or not a person is present. On a machine with Modern
//! Standby the system promises a desktop process no resume message on leaving standby, and a
//! standby runs from the console's display turning off to its turning on, so there the display
//! turning on from off is a wake too (`GUID_CONSOLE_DISPLAY_STATE` through
//! `PowerSettingRegisterNotification`). Wakes that come while no one waits count as one; a resume
//! heard both ways may be told twice.

use std::ffi::c_void;
use std::future::{self, Future};
use std::io;
use std::mem::{self, ManuallyDrop};
use std::ptr;
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use tokio::sync::Notify;
use windows_sys::Win32::Foundation::{ERROR_SUCCESS, WIN32_ERROR};
use windows_sys::Win32::System::Power::{
    CallNtPowerInformation, DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS, HPOWERNOTIFY,
    POWERBROADCAST_SETTING, PowerRegisterSuspendResumeNotification,
    PowerSettingRegisterNotification, PowerSettingUnregisterNotification,
    PowerUnregisterSuspendResumeNotification, SYSTEM_POWER_CAPABILITIES, SystemPowerCapabilities,
};
use windows_sys::Win32::System::SystemServices::{
    GUID_CONSOLE_DISPLAY_STATE, MONITOR_DISPLAY_STATE, PowerMonitorOff,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    DEVICE_NOTIFY_CALLBACK, PBT_APMRESUMEAUTOMATIC, PBT_POWERSETTINGCHANGE,
};

use crate::wake_watch::WakeWatchError;

// What announces the wakes, as an error names it.
const SOURCE_NAME: &str = "PowerRegisterSuspendResumeNotification";

// The display state before the registration's first callback gives the state then.
const DISPLAY_STATE_UNKNOWN: MONITOR_DISPLAY_STATE = -1;

// The status `CallNtPowerInformation` answers with when it succeeds.
const STATUS_SUCCESS: i32 = 0;

// The running watch's wakes, which the callback tells. Process-wide, since the system documents no
// wait for a callback under way when a registration ends, so nothing the callback reads may be
// freed; empty while no watch runs, and a second watch is refused.
static WAKES: Mutex<Option<Arc<Notify>>> = Mutex::new(None);

// The console display's last state, so only its turning on from off is a wake.
static DISPLAY_STATE: AtomicI32 = AtomicI32::new(DISPLAY_STATE_UNKNOWN);

/// The machine's wakes from sleep, heard from the system's resume notifications and, with Modern
/// Standby, from the console's display turning on. One runs in the process at a time.
pub struct WakeWatch {
    wakes: Arc<Notify>,
    resume_registration: HPOWERNOTIFY,
    display_registration: Option<HPOWERNOTIFY>,
    // Kept for the registrations' life, since the system documents no copy of it, and never freed
    // after a registration fails to end.
    subscription: ManuallyDrop<Box<DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS>>,
}

// SAFETY: the subscription is read only by the system, and the registrations are ended by the drop
// alone.
unsafe impl Send for WakeWatch {}

impl WakeWatch {
    /// Starts hearing the machine's wakes. Fails with [`WakeWatchError`] when a watch already runs
    /// in the process, when the system refuses a registration, or when it cannot say whether the
    /// machine has Modern Standby.
    pub fn start() -> impl Future<Output = Result<Self, WakeWatchError>> {
        future::ready(Self::register())
    }

    /// Waits for the machine's next wake; wakes that came while no one waited count as one.
    /// Cancel-safe, and never fails on Windows.
    pub async fn next_wake(&mut self) -> Result<(), WakeWatchError> {
        self.wakes.notified().await;
        Ok(())
    }

    fn register() -> Result<Self, WakeWatchError> {
        let wakes = {
            let mut running_wakes = lock_wakes();
            if running_wakes.is_some() {
                return Err(watch_failure(io::Error::other(
                    "a watch already hears the wakes in this process",
                )));
            }
            running_wakes.insert(Arc::new(Notify::new())).clone()
        };
        DISPLAY_STATE.store(DISPLAY_STATE_UNKNOWN, Ordering::Release);
        let subscription = Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
            Callback: Some(on_power_event),
            Context: ptr::null_mut(),
        });
        let mut resume_registration: *mut c_void = ptr::null_mut();
        // SAFETY: the subscription lives in a box the watch keeps until the drop ends the
        // registration; the out pointer is this frame's local.
        let outcome = unsafe {
            PowerRegisterSuspendResumeNotification(
                DEVICE_NOTIFY_CALLBACK,
                ptr::from_ref(&*subscription).cast_mut().cast(),
                &raw mut resume_registration,
            )
        };
        if outcome != ERROR_SUCCESS {
            *lock_wakes() = None;
            return Err(registration_failure(outcome));
        }
        // From here the drop ends what was registered if a later step fails.
        let mut watch = Self {
            wakes,
            resume_registration: resume_registration.addr().cast_signed(),
            display_registration: None,
            subscription: ManuallyDrop::new(subscription),
        };
        if has_modern_standby()? {
            let mut display_registration: *mut c_void = ptr::null_mut();
            // SAFETY: as above; the setting is the system's own constant.
            let outcome = unsafe {
                PowerSettingRegisterNotification(
                    &GUID_CONSOLE_DISPLAY_STATE,
                    DEVICE_NOTIFY_CALLBACK,
                    ptr::from_ref(&**watch.subscription).cast_mut().cast(),
                    &raw mut display_registration,
                )
            };
            if outcome != ERROR_SUCCESS {
                return Err(registration_failure(outcome));
            }
            watch.display_registration = Some(display_registration.addr().cast_signed());
        }
        Ok(watch)
    }
}

impl Drop for WakeWatch {
    fn drop(&mut self) {
        // SAFETY: the registration is the watch's own and is ended once.
        let mut is_ended = report_end(unsafe {
            PowerUnregisterSuspendResumeNotification(self.resume_registration)
        });
        if let Some(display_registration) = self.display_registration {
            // SAFETY: the registration is the watch's own and is ended once.
            is_ended &=
                report_end(unsafe { PowerSettingUnregisterNotification(display_registration) });
        }
        if is_ended {
            // SAFETY: no registration reads the subscription any more, and it is dropped once.
            unsafe { ManuallyDrop::drop(&mut self.subscription) };
        }
        *lock_wakes() = None;
    }
}

fn lock_wakes() -> MutexGuard<'static, Option<Arc<Notify>>> {
    WAKES.lock().unwrap_or_else(PoisonError::into_inner)
}

// Whether the machine sleeps by Modern Standby, which the system reports as always-on-always-
// connected power.
fn has_modern_standby() -> Result<bool, WakeWatchError> {
    let mut capabilities = SYSTEM_POWER_CAPABILITIES::default();
    let capabilities_size = u32::try_from(mem::size_of::<SYSTEM_POWER_CAPABILITIES>())
        .expect("the capabilities' size fits 32 bits");
    // SAFETY: the output is this frame's local, of the size given; no input.
    let status = unsafe {
        CallNtPowerInformation(
            SystemPowerCapabilities,
            ptr::null(),
            0,
            (&raw mut capabilities).cast(),
            capabilities_size,
        )
    };
    if status != STATUS_SUCCESS {
        return Err(watch_failure(io::Error::other(format!(
            "the power capabilities could not be read (status {status:#x})"
        ))));
    }
    Ok(capabilities.AoAc)
}

// Logs a registration that could not be ended, and says whether it ended.
fn report_end(outcome: WIN32_ERROR) -> bool {
    if outcome == ERROR_SUCCESS {
        return true;
    }
    tracing::warn!(
        error = &io::Error::from_raw_os_error(outcome.cast_signed())
            as &(dyn std::error::Error + 'static),
        "A wake notification could not be ended"
    );
    false
}

fn registration_failure(outcome: WIN32_ERROR) -> WakeWatchError {
    watch_failure(io::Error::from_raw_os_error(outcome.cast_signed()))
}

fn watch_failure(failure: io::Error) -> WakeWatchError {
    WakeWatchError {
        source_name: SOURCE_NAME,
        source: failure.into(),
    }
}

// Tells the running watch a resume, or the console's display turning on from off.
unsafe extern "system" fn on_power_event(
    _context: *const c_void,
    event_type: u32,
    setting: *const c_void,
) -> u32 {
    let is_wake = match event_type {
        PBT_APMRESUMEAUTOMATIC => true,
        PBT_POWERSETTINGCHANGE => {
            // SAFETY: a setting change's argument is the system's `POWERBROADCAST_SETTING` for the
            // one setting registered, the console's display state, whose data is one
            // `MONITOR_DISPLAY_STATE`, read unaligned from the byte array that holds it.
            let display_state = unsafe {
                ptr::read_unaligned(
                    (&raw const (*setting.cast::<POWERBROADCAST_SETTING>()).Data)
                        .cast::<MONITOR_DISPLAY_STATE>(),
                )
            };
            let previous_state = DISPLAY_STATE.swap(display_state, Ordering::AcqRel);
            previous_state == PowerMonitorOff && display_state != PowerMonitorOff
        }
        _ => false,
    };
    if is_wake && let Some(wakes) = &*lock_wakes() {
        wakes.notify_one();
    }
    ERROR_SUCCESS
}
