//! Whether this Mac runs on AC power: the power-source notification `notify.h` posts on connecting
//! or disconnecting AC power, delivered on a dispatch queue of its own, each one and the start
//! reading which source provides power. A registration or read that fails reads as not on AC.

use std::error::Error;
use std::ffi::{c_char, c_int};
use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use block2::{Block, RcBlock};
use dispatch2::DispatchQueue;
use objc2_io_kit::{
    IOPSCopyPowerSourcesInfo, IOPSGetProvidingPowerSourceType, kIOPSACPowerValue,
    kIOPSNotifyPowerSource,
};
use tokio::sync::watch;

// The label of the queue the power-source notifications arrive on.
const QUEUE_LABEL: &str = "sidekicks.power-source";

// `notify.h`'s success status.
const NOTIFY_STATUS_OK: u32 = 0;

// SAFETY: both are libSystem's, declared with `notify.h`'s own types: a C string, an `int` out
// pointer, a dispatch queue and a block taking the `int` token; each answers a `uint32_t` status.
unsafe extern "C" {
    fn notify_register_dispatch(
        name: *const c_char,
        out_token: *mut c_int,
        queue: &DispatchQueue,
        handler: &Block<dyn Fn(c_int)>,
    ) -> u32;
    fn notify_cancel(token: c_int) -> u32;
}

// What the notification handler and the start share: the published reading, and whether the
// failure now running has been logged.
struct PowerSourceState {
    on_ac: watch::Sender<bool>,
    is_failure_logged: AtomicBool,
}

impl PowerSourceState {
    // Reads the providing source and publishes whether it is AC, only when that changed; a failed
    // read publishes not on AC and logs once until a read succeeds again.
    fn publish_reading(&self) {
        let on_ac = match read_is_on_ac() {
            Ok(on_ac) => {
                self.is_failure_logged.store(false, Ordering::Relaxed);
                on_ac
            }
            Err(error) => {
                self.log_failure_once(&error);
                false
            }
        };
        self.on_ac.send_if_modified(|current| {
            let is_changed = *current != on_ac;
            *current = on_ac;
            is_changed
        });
    }

    fn log_failure_once(&self, error: &io::Error) {
        if !self.is_failure_logged.swap(true, Ordering::Relaxed) {
            tracing::warn!(
                error = error as &(dyn Error + 'static),
                "The power source cannot be read, so this Mac reads as not on AC power"
            );
        }
    }
}

/// Whether this Mac runs on AC power, heard from the system's power-source notification and read
/// once at start; a registration or read that fails reads as not on AC.
pub struct PowerSourceWatch {
    // `None` when the registration failed, so nothing is canceled.
    token: Option<c_int>,
    // Keeps the sender, so receivers stay open while the watch lives.
    state: Arc<PowerSourceState>,
}

impl PowerSourceWatch {
    /// Starts hearing the power source and reads it once before returning. Never fails: a
    /// registration the system refuses is logged and the watch reads not on AC from then on.
    pub fn start() -> Self {
        let state = Arc::new(PowerSourceState {
            on_ac: watch::Sender::new(false),
            is_failure_logged: AtomicBool::new(false),
        });
        let queue = DispatchQueue::new(QUEUE_LABEL, None);
        let handler_state = Arc::clone(&state);
        let handler = RcBlock::new(move |_token: c_int| handler_state.publish_reading());
        let mut token: c_int = -1;
        // SAFETY: the name is a static C string, the token this frame's local; notify copies the
        // block and retains the queue for the registration's life, so both may drop after it.
        let status = unsafe {
            notify_register_dispatch(
                kIOPSNotifyPowerSource.as_ptr(),
                &raw mut token,
                &queue,
                &handler,
            )
        };
        if status != NOTIFY_STATUS_OK {
            state.log_failure_once(&io::Error::other(format!(
                "notify_register_dispatch answered status {status}"
            )));
            return Self { token: None, state };
        }
        // Read on the notifications' queue, so a notification racing the start cannot publish
        // before it and be overwritten by an older reading.
        queue.exec_sync(|| state.publish_reading());
        Self {
            token: Some(token),
            state,
        }
    }

    /// A receiver of whether this Mac runs on AC power, holding the newest reading and told of
    /// each change.
    pub fn receiver(&self) -> watch::Receiver<bool> {
        self.state.on_ac.subscribe()
    }
}

impl Drop for PowerSourceWatch {
    fn drop(&mut self) {
        if let Some(token) = self.token {
            // SAFETY: the token is this watch's own registration, canceled once.
            let status = unsafe { notify_cancel(token) };
            if status != NOTIFY_STATUS_OK {
                tracing::warn!(
                    status,
                    "The power-source registration could not be canceled"
                );
            }
        }
    }
}

// Whether the source providing power is AC, from a snapshot of the power sources.
fn read_is_on_ac() -> io::Result<bool> {
    let snapshot = IOPSCopyPowerSourcesInfo()
        .ok_or_else(|| io::Error::other("IOPSCopyPowerSourcesInfo answered nothing"))?;
    // SAFETY: the snapshot is the one `IOPSCopyPowerSourcesInfo` just returned, never nil.
    let source = unsafe { IOPSGetProvidingPowerSourceType(Some(&snapshot)) }
        .ok_or_else(|| io::Error::other("IOPSGetProvidingPowerSourceType answered nothing"))?;
    Ok(source.to_string().as_bytes() == kIOPSACPowerValue.to_bytes())
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use super::PowerSourceWatch;

    #[test]
    fn a_new_watch_reads_the_power_source_pmset_reports() {
        let output = Command::new("/usr/bin/pmset")
            .args(["-g", "batt"])
            .output()
            .expect("pmset runs");
        assert!(output.status.success());
        let is_on_ac = String::from_utf8_lossy(&output.stdout).contains("'AC Power'");

        let watch = PowerSourceWatch::start();
        assert_eq!(*watch.receiver().borrow(), is_on_ac);
    }
}
