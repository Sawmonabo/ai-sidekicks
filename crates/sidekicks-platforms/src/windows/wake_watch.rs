//! The machine's wakes from sleep on Windows, from one source per kind of machine, so each wake is
//! told once; both register a callback, which needs no window. A machine with Modern Standby
//! promises a desktop process no resume message on leaving standby, and its standby runs from the
//! console's display turning off to its turning on, so there a wake is the display turning on from
//! off (`GUID_CONSOLE_DISPLAY_STATE` through `PowerSettingRegisterNotification`). Any other machine
//! tells each resume from sleep or hibernation at `PBT_APMRESUMEAUTOMATIC`
//! (`PowerRegisterSuspendResumeNotification`), sent whether or not a person is present. Wakes that
//! come while no one waits count as one.

use std::ffi::c_void;
use std::future::{self, Future};
use std::io;
use std::mem::{self, ManuallyDrop};
use std::ptr;
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use tokio::sync::Notify;
use windows_sys::Win32::Foundation::{ERROR_SUCCESS, HANDLE, WIN32_ERROR};
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
const SOURCE_NAME: &str = "the system's power notifications";

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

/// The machine's wakes from sleep, heard from the console's display turning on with Modern
/// Standby and from the system's resume notifications otherwise. One runs in the process at a time.
pub struct WakeWatch {
    wakes: Arc<Notify>,
    registration: PowerRegistration,
    // Kept for the registration's life, since the system documents no copy of it, and never freed
    // after the registration fails to end.
    subscription: ManuallyDrop<Box<DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS>>,
}

// The one registration a watch holds, which its kind of machine decides.
enum PowerRegistration {
    ConsoleDisplay(HPOWERNOTIFY),
    Resume(HPOWERNOTIFY),
}

// SAFETY: the subscription is read only by the system, and the registration is ended by the drop
// alone.
unsafe impl Send for WakeWatch {}

impl WakeWatch {
    /// Starts hearing the machine's wakes. Fails with [`WakeWatchError`] when a watch already runs
    /// in the process, when the system refuses the registration, or when it cannot say whether the
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
        let subscription = Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
            Callback: Some(on_power_event),
            Context: ptr::null_mut(),
        });
        let recipient = ptr::from_ref(&*subscription).cast_mut().cast();
        match has_modern_standby()
            .and_then(|is_modern_standby| register_for_wakes(is_modern_standby, recipient))
        {
            Ok(registration) => Ok(Self {
                wakes,
                registration,
                subscription: ManuallyDrop::new(subscription),
            }),
            Err(failure) => {
                *lock_wakes() = None;
                Err(failure)
            }
        }
    }
}

impl Drop for WakeWatch {
    fn drop(&mut self) {
        // SAFETY: the registration is the watch's own and is ended once.
        let outcome = unsafe {
            match self.registration {
                PowerRegistration::ConsoleDisplay(registration) => {
                    PowerSettingUnregisterNotification(registration)
                }
                PowerRegistration::Resume(registration) => {
                    PowerUnregisterSuspendResumeNotification(registration)
                }
            }
        };
        if report_end(outcome) {
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

// Registers `recipient` for the one source of wakes the kind of machine has.
fn register_for_wakes(
    is_modern_standby: bool,
    recipient: HANDLE,
) -> Result<PowerRegistration, WakeWatchError> {
    let mut registration: *mut c_void = ptr::null_mut();
    let outcome = if is_modern_standby {
        DISPLAY_STATE.store(DISPLAY_STATE_UNKNOWN, Ordering::Release);
        // SAFETY: the recipient is the watch's boxed subscription, kept until the drop ends the
        // registration; the setting is the system's own constant and the out pointer this frame's
        // local.
        unsafe {
            PowerSettingRegisterNotification(
                &GUID_CONSOLE_DISPLAY_STATE,
                DEVICE_NOTIFY_CALLBACK,
                recipient,
                &raw mut registration,
            )
        }
    } else {
        // SAFETY: as above.
        unsafe {
            PowerRegisterSuspendResumeNotification(
                DEVICE_NOTIFY_CALLBACK,
                recipient,
                &raw mut registration,
            )
        }
    };
    if outcome != ERROR_SUCCESS {
        return Err(registration_failure(outcome));
    }
    let registration = registration.addr().cast_signed();
    Ok(if is_modern_standby {
        PowerRegistration::ConsoleDisplay(registration)
    } else {
        PowerRegistration::Resume(registration)
    })
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

// Tells the running watch a resume, or the console's display turning on from off; a watch
// registers for one of the two.
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
