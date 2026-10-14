//! The machine's wakes from sleep on macOS: the root power domain's messages through
//! `IORegisterForSystemPower`, delivered on a dispatch queue of their own. A sleep the system asks
//! about or announces is allowed at once with `IOAllowPowerChange`, so the service never holds it
//! back; a wake is heard once every driver has powered on again.

use std::ffi::c_void;
use std::io;
use std::ptr;
use std::sync::atomic::{AtomicU32, Ordering};

use dispatch2::{DispatchQueue, DispatchRetained};
use objc2_io_kit::{
    IO_OBJECT_NULL, IOAllowPowerChange, IODeregisterForSystemPower, IONotificationPort,
    IONotificationPortRef, IORegisterForSystemPower, IOServiceClose, io_object_t, io_service_t,
    kIOMessageCanSystemSleep, kIOMessageSystemHasPoweredOn, kIOMessageSystemWillSleep,
    kIOReturnSuccess,
};
use tokio::sync::Notify;

use crate::wake_watch::WakeWatchError;

// What announces the wakes, as an error names it.
const SOURCE_NAME: &str = "IORegisterForSystemPower";

// The label of the queue the power messages arrive on.
const QUEUE_LABEL: &str = "sidekicks.wake-watch";

// What the power callback reads: the root domain's connection, which allows a sleep, and the wakes
// it announces.
struct PowerMessageContext {
    root_domain: AtomicU32,
    wakes: Notify,
}

/// The machine's wakes from sleep, heard from the root power domain.
pub struct WakeWatch {
    // Boxed so its address, which the callback holds, stays put for the registration's life.
    context: Box<PowerMessageContext>,
    notifier: io_object_t,
    notification_port: IONotificationPortRef,
    queue: DispatchRetained<DispatchQueue>,
}

// SAFETY: the notification port is touched only by the drop, which owns the watch; the callback
// reads the context through its own pointer on the watch's queue.
unsafe impl Send for WakeWatch {}

impl WakeWatch {
    /// Starts hearing the machine's wakes. Fails with [`WakeWatchError`] when the root power domain
    /// refuses the registration.
    #[expect(
        clippy::unused_async,
        reason = "the interface is async because Linux's start connects to the system bus"
    )]
    pub async fn start() -> Result<Self, WakeWatchError> {
        let context = Box::new(PowerMessageContext {
            root_domain: AtomicU32::new(IO_OBJECT_NULL),
            wakes: Notify::new(),
        });
        let mut notification_port: IONotificationPortRef = ptr::null_mut();
        let mut notifier: io_object_t = IO_OBJECT_NULL;
        // SAFETY: the context outlives the registration, which the drop ends first; the two out
        // pointers are this frame's locals; the callback matches `IOServiceInterestCallback`.
        let root_domain = unsafe {
            IORegisterForSystemPower(
                ptr::from_ref(&*context).cast_mut().cast(),
                &raw mut notification_port,
                Some(on_power_message),
                &raw mut notifier,
            )
        };
        if root_domain == IO_OBJECT_NULL {
            return Err(WakeWatchError {
                source_name: SOURCE_NAME,
                source: io::Error::other("the root power domain refused the registration").into(),
            });
        }
        // Stored before the queue is set, so no message arrives before the callback can allow it.
        context.root_domain.store(root_domain, Ordering::Release);
        let queue = DispatchQueue::new(QUEUE_LABEL, None);
        // SAFETY: the port is the registration's own, and the drop destroys it before the queue.
        unsafe { IONotificationPort::set_dispatch_queue(notification_port, Some(&queue)) };
        Ok(Self {
            context,
            notifier,
            notification_port,
            queue,
        })
    }

    /// Waits for the machine's next wake; wakes that came while no one waited count as one.
    /// Cancel-safe, and never fails on macOS.
    pub async fn next_wake(&mut self) -> Result<(), WakeWatchError> {
        self.context.wakes.notified().await;
        Ok(())
    }
}

impl Drop for WakeWatch {
    fn drop(&mut self) {
        // SAFETY: the notifier is the registration's own and is deregistered once.
        unsafe { IODeregisterForSystemPower(&raw mut self.notifier) };
        IOServiceClose(self.context.root_domain.load(Ordering::Acquire));
        // SAFETY: the port is the registration's own, destroyed once, after the notifier that fed it.
        unsafe { IONotificationPort::destroy(self.notification_port) };
        // A message already queued runs before this returns, so none reads the context once it goes.
        self.queue.exec_sync(|| {});
    }
}

// Allows every sleep at once and tells a wake to the watch.
unsafe extern "C-unwind" fn on_power_message(
    refcon: *mut c_void,
    _service: io_service_t,
    message_type: u32,
    message_argument: *mut c_void,
) {
    // SAFETY: `refcon` is the watch's boxed context, which outlives every message (see the drop).
    let context = unsafe { &*refcon.cast::<PowerMessageContext>() };
    if message_type == kIOMessageCanSystemSleep || message_type == kIOMessageSystemWillSleep {
        // The message's argument is the notification id the allow answers.
        let allowed = IOAllowPowerChange(
            context.root_domain.load(Ordering::Acquire),
            message_argument as isize,
        );
        if allowed != kIOReturnSuccess {
            // The system goes on sleeping once its 30 s wait for the answer ends.
            tracing::warn!(code = allowed, "A sleep could not be allowed at once");
        }
    } else if message_type == kIOMessageSystemHasPoweredOn {
        context.wakes.notify_one();
    }
}
