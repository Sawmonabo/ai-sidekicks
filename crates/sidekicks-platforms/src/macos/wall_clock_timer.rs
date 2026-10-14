//! A timer for an instant on the wall clock on macOS: a dispatch timer source started from
//! `dispatch_walltime`, which libdispatch keeps on the calendar clock, so it fires at the instant
//! across sleep and across any change to the clock.

use std::ffi::c_void;
use std::io;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use dispatch2::{
    _dispatch_source_type_timer, DispatchObject, DispatchQueue, DispatchRetained, DispatchSource,
    DispatchTime,
};
use tokio::sync::Notify;

// The label of the queue the timer's firing arrives on.
const QUEUE_LABEL: &str = "sidekicks.wall-clock-timer";

// The repeat a one-shot timer takes.
const NO_REPEAT: u64 = DispatchTime::FOREVER.0;

// How late the system may fire it to group wakes: not at all, since it is armed rarely.
const NO_LEEWAY: u64 = 0;

/// A timer that fires once at an instant on the wall clock, kept by the operating system across
/// sleep and clock changes; it holds at most one instant.
pub struct WallClockTimer {
    source: DispatchRetained<DispatchSource>,
    fired: Arc<Notify>,
}

impl WallClockTimer {
    /// A timer armed for no instant. Fails only where the system refuses a timer, never on macOS.
    pub fn new() -> io::Result<Self> {
        // The source keeps its queue alive, so the timer holds no handle to it.
        let queue = DispatchQueue::new(QUEUE_LABEL, None);
        let fired = Arc::new(Notify::new());
        // SAFETY: a timer source takes no handle and no mask.
        let source = unsafe {
            DispatchSource::new(
                (&raw const _dispatch_source_type_timer).cast_mut(),
                0,
                0,
                Some(&queue),
            )
        };
        // SAFETY: the context is a counted reference the finalizer gives back once the source is
        // freed, and the handler only reads it.
        unsafe {
            source.set_context(Arc::into_raw(Arc::clone(&fired)).cast_mut().cast());
            source.set_finalizer_f(release_fired);
        }
        // Set after the context, which the handler is given.
        source.set_event_handler_f(on_fire);
        source.set_timer(DispatchTime::FOREVER, NO_REPEAT, NO_LEEWAY);
        source.activate();
        Ok(Self { source, fired })
    }

    /// Arms the timer for `instant`, in place of any instant it held; one already past fires at
    /// once. Never fails on macOS.
    pub fn arm(&mut self, instant: SystemTime) -> io::Result<()> {
        let since_epoch = instant.duration_since(UNIX_EPOCH).unwrap_or_default();
        let wall_time = libc::timespec {
            tv_sec: libc::time_t::try_from(since_epoch.as_secs()).unwrap_or(libc::time_t::MAX),
            tv_nsec: libc::c_long::from(since_epoch.subsec_nanos()),
        };
        // SAFETY: the pointer is to a local that lives across the call.
        let start = unsafe { DispatchTime::walltime(&raw const wall_time, 0) };
        self.source.set_timer(start, NO_REPEAT, NO_LEEWAY);
        Ok(())
    }

    /// Disarms the timer. Never fails on macOS.
    pub fn disarm(&mut self) -> io::Result<()> {
        self.source
            .set_timer(DispatchTime::FOREVER, NO_REPEAT, NO_LEEWAY);
        Ok(())
    }

    /// Waits until the armed instant may have passed; the caller compares the wall clock and arms
    /// again. A firing that came while no one waited ends the next wait at once. Cancel-safe, and
    /// never fails on macOS.
    pub async fn wait(&mut self) -> io::Result<()> {
        self.fired.notified().await;
        Ok(())
    }
}

impl Drop for WallClockTimer {
    fn drop(&mut self) {
        self.source.cancel();
    }
}

// Tells the waiter the timer fired.
extern "C" fn on_fire(context: *mut c_void) {
    // SAFETY: the context is the counted reference set in `new`, released only by the finalizer,
    // which runs after the last handler.
    let fired = unsafe { &*context.cast::<Notify>() };
    fired.notify_one();
}

// Gives back the counted reference the source held.
extern "C" fn release_fired(context: *mut c_void) {
    // SAFETY: the context is the counted reference set in `new`, and the finalizer runs once.
    drop(unsafe { Arc::from_raw(context.cast::<Notify>()) });
}
