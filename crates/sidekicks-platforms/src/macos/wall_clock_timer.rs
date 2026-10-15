//! The wall clock's timer on macOS: a dispatch timer source started from `dispatch_walltime`, which
//! libdispatch keeps on the calendar clock, so it fires at its instant across sleep and across any
//! change to the clock, and never before it.

use std::ffi::c_void;
use std::io;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use dispatch2::{
    _dispatch_source_type_timer, DispatchObject, DispatchQueue, DispatchRetained, DispatchSource,
    DispatchTime,
};
use tokio::sync::Notify;

use crate::wall_clock::{WallClock, WallClockWait};

// The label of the queue the timer's firing arrives on.
const QUEUE_LABEL: &str = "sidekicks.wall-clock-timer";

// The repeat a one-shot timer takes.
const NO_REPEAT: u64 = DispatchTime::FOREVER.0;

// How late the system may fire it to group wakes: not at all, since it is armed rarely.
const NO_LEEWAY: u64 = 0;

// The nanoseconds since 1970 a wall time can hold. At one or less `dispatch_walltime` answers
// "forever", and past the largest the value no longer reads as a wall time.
const EARLIEST_WALL_NANOSECONDS: u128 = 2;
const LATEST_WALL_NANOSECONDS: u128 = (1 << 62) - 1;

// The nanoseconds in a second, as a `timespec` splits them.
const NANOSECONDS_PER_SECOND: u128 = 1_000_000_000;

/// The system's wall clock and its timer on macOS.
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
}

impl WallClock for WallClockTimer {
    fn arm(&self, instant: SystemTime) -> io::Result<()> {
        self.source
            .set_timer(dispatch_start(instant), NO_REPEAT, NO_LEEWAY);
        Ok(())
    }

    fn disarm(&self) -> io::Result<()> {
        self.source
            .set_timer(DispatchTime::FOREVER, NO_REPEAT, NO_LEEWAY);
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
        self.source.cancel();
    }
}

// The start `instant` takes as a wall time: one at or before 1970 reads as its earliest, which is
// past and fires at once, and one past its range as never.
fn dispatch_start(instant: SystemTime) -> DispatchTime {
    let nanoseconds = instant
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .max(EARLIEST_WALL_NANOSECONDS);
    if nanoseconds > LATEST_WALL_NANOSECONDS {
        return DispatchTime::FOREVER;
    }
    let seconds = libc::time_t::try_from(nanoseconds / NANOSECONDS_PER_SECOND)
        .expect("a wall time's seconds fit the system's time");
    let wall_time = libc::timespec {
        tv_sec: seconds,
        tv_nsec: libc::c_long::try_from(nanoseconds % NANOSECONDS_PER_SECOND)
            .expect("a second's nanoseconds fit a long"),
    };
    // SAFETY: the pointer is to a local that lives across the call.
    unsafe { DispatchTime::walltime(&raw const wall_time, 0) }
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

#[cfg(test)]
mod tests {
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use dispatch2::DispatchTime;
    use rstest::rstest;

    use super::dispatch_start;

    // A wall time is the negated count of nanoseconds since 1970; `None` is a timer never armed.
    #[rstest]
    #[case::before_1970(UNIX_EPOCH - Duration::from_secs(1), Some(2))]
    #[case::at_1970(UNIX_EPOCH, Some(2))]
    #[case::one_nanosecond_past_1970(UNIX_EPOCH + Duration::from_nanos(1), Some(2))]
    #[case::past_the_earliest(UNIX_EPOCH + Duration::from_nanos(3), Some(3))]
    #[case::latest(UNIX_EPOCH + Duration::from_nanos((1 << 62) - 1), Some((1 << 62) - 1))]
    #[case::past_the_latest(UNIX_EPOCH + Duration::from_nanos(1 << 62), None)]
    fn an_instant_starts_the_timer_at_its_wall_time_or_never(
        #[case] instant: SystemTime,
        #[case] wall_nanoseconds: Option<u64>,
    ) {
        let expected = wall_nanoseconds.map_or(DispatchTime::FOREVER.0, u64::wrapping_neg);
        assert_eq!(dispatch_start(instant).0, expected);
    }
}
