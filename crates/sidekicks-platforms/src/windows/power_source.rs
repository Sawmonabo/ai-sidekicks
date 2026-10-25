//! Whether this machine runs on AC power on Windows: the system's power-source setting
//! (`GUID_ACDC_POWER_SOURCE`) through `PowerSettingRegisterNotification` with a callback, which
//! needs no window; the system calls it with the current source right after the registration and
//! again at each change. A registration the system refuses reads as not on AC power.

use std::error::Error;
use std::ffi::c_void;
use std::io;
use std::mem::ManuallyDrop;
use std::ptr;
use std::sync::LazyLock;

use tokio::sync::watch;
use windows_sys::Win32::Foundation::ERROR_SUCCESS;
use windows_sys::Win32::System::Power::{
    DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS, HPOWERNOTIFY, POWERBROADCAST_SETTING, PoAc,
    PowerSettingRegisterNotification, PowerSettingUnregisterNotification, SYSTEM_POWER_CONDITION,
};
use windows_sys::Win32::System::SystemServices::GUID_ACDC_POWER_SOURCE;
use windows_sys::Win32::UI::WindowsAndMessaging::{DEVICE_NOTIFY_CALLBACK, PBT_POWERSETTINGCHANGE};

// The newest reading, which the callback publishes. Process-wide, since the system documents no
// wait for a callback under way when a registration ends, so nothing the callback reads may be
// freed.
static ON_AC: LazyLock<watch::Sender<bool>> = LazyLock::new(|| watch::Sender::new(false));

/// Whether this machine runs on AC power, heard from the system's power-source setting, whose
/// registration reads it at once; a registration the system refuses reads as not on AC. One
/// reading serves every watch in the process: a new watch starts from the last reading any watch
/// published, and a refused registration publishes not on AC for every live watch.
pub struct PowerSourceWatch {
    // `None` when the registration failed, so nothing is ended.
    registration: Option<HPOWERNOTIFY>,
    // Kept for the registration's life, since the system documents no copy of it, and never freed
    // after the registration fails to end.
    subscription: ManuallyDrop<Box<DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS>>,
}

// SAFETY: the subscription is read only by the system, and the registration is ended by the drop
// alone; no method reads either.
unsafe impl Send for PowerSourceWatch {}
// SAFETY: as above, so a shared watch gives no access to either.
unsafe impl Sync for PowerSourceWatch {}

impl PowerSourceWatch {
    /// Starts hearing the power source; the reading is the process's last one (not on AC when
    /// none was ever published) until the system's first callback, which follows the registration
    /// at once. Never fails: a registration the system refuses is logged and every watch in the
    /// process reads not on AC from then on.
    pub fn start() -> Self {
        let subscription = Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
            Callback: Some(on_power_source_change),
            Context: ptr::null_mut(),
        });
        let recipient = ptr::from_ref(&*subscription).cast_mut().cast();
        let mut registration: *mut c_void = ptr::null_mut();
        // SAFETY: the recipient is the watch's boxed subscription, kept until the drop ends the
        // registration; the setting is the system's own constant and the out pointer this frame's
        // local.
        let outcome = unsafe {
            PowerSettingRegisterNotification(
                &GUID_ACDC_POWER_SOURCE,
                DEVICE_NOTIFY_CALLBACK,
                recipient,
                &raw mut registration,
            )
        };
        let registration = if outcome == ERROR_SUCCESS {
            Some(registration.addr().cast_signed())
        } else {
            tracing::warn!(
                error =
                    &io::Error::from_raw_os_error(outcome.cast_signed()) as &(dyn Error + 'static),
                "the power source cannot be heard, so this machine reads as not on ac power"
            );
            ON_AC.send_replace(false);
            None
        };
        Self {
            registration,
            subscription: ManuallyDrop::new(subscription),
        }
    }

    /// A receiver of whether this machine runs on AC power, holding the newest reading and told of
    /// each change.
    pub fn receiver(&self) -> watch::Receiver<bool> {
        ON_AC.subscribe()
    }
}

impl Drop for PowerSourceWatch {
    fn drop(&mut self) {
        let Some(registration) = self.registration else {
            // SAFETY: no registration reads the subscription, and it is dropped once.
            unsafe { ManuallyDrop::drop(&mut self.subscription) };
            return;
        };
        // SAFETY: the registration is the watch's own and is ended once.
        let outcome = unsafe { PowerSettingUnregisterNotification(registration) };
        if outcome == ERROR_SUCCESS {
            // SAFETY: no registration reads the subscription any more, and it is dropped once.
            unsafe { ManuallyDrop::drop(&mut self.subscription) };
        } else {
            tracing::warn!(
                error =
                    &io::Error::from_raw_os_error(outcome.cast_signed()) as &(dyn Error + 'static),
                "the power-source notification could not be ended"
            );
        }
    }
}

// Publishes whether the power source the system reports is AC, only when that changed.
unsafe extern "system" fn on_power_source_change(
    _context: *const c_void,
    event_type: u32,
    setting: *const c_void,
) -> u32 {
    if event_type == PBT_POWERSETTINGCHANGE {
        // SAFETY: a setting change's argument is the system's `POWERBROADCAST_SETTING` for the one
        // setting registered, the power source, whose data is one `SYSTEM_POWER_CONDITION`, read
        // unaligned from the byte array that holds it.
        let condition = unsafe {
            ptr::read_unaligned(
                (&raw const (*setting.cast::<POWERBROADCAST_SETTING>()).Data)
                    .cast::<SYSTEM_POWER_CONDITION>(),
            )
        };
        let is_on_ac = condition == PoAc;
        ON_AC.send_if_modified(|current| {
            let is_changed = *current != is_on_ac;
            *current = is_on_ac;
            is_changed
        });
    }
    ERROR_SUCCESS
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};

    use super::PowerSourceWatch;

    // `GetSystemPowerStatus`'s line status: offline, online, or unknown.
    const AC_LINE_OFFLINE: u8 = 0;
    const AC_LINE_ONLINE: u8 = 1;

    // The reading is seeded with the opposite of the system's answer, so only the callback can
    // satisfy the wait. Killed by the callback's reading inverted (`condition != PoAc`).
    #[tokio::test]
    async fn a_new_watch_reads_the_power_source_the_system_reports() {
        let mut status = SYSTEM_POWER_STATUS::default();
        // SAFETY: the output is this frame's local.
        let is_read = unsafe { GetSystemPowerStatus(&raw mut status) } != 0;
        assert!(is_read, "the power status reads");
        let is_on_ac = match status.ACLineStatus {
            AC_LINE_OFFLINE => false,
            AC_LINE_ONLINE => true,
            // The system has no reading to compare the watch against.
            _ => return,
        };
        super::ON_AC.send_replace(!is_on_ac);

        let watch = PowerSourceWatch::start();
        let mut receiver = watch.receiver();
        // A ceiling over a callback the system documents as immediate after the registration, not
        // a poll.
        tokio::time::timeout(
            Duration::from_secs(5),
            receiver.wait_for(|on_ac| *on_ac == is_on_ac),
        )
        .await
        .expect("the first callback publishes the source")
        .expect("the watch stays open");
    }
}
