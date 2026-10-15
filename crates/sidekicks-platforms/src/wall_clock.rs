//! The wall clock and a timer that fires at an instant on it, as one interface, so code that
//! compares an instant with the clock reads the clock the timer keeps; each platform's
//! `WallClockTimer` is the system's.

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::time::SystemTime;

/// What [`WallClock::wait`] returns: a wait that borrows the timer.
pub type WallClockWait<'timer> = Pin<Box<dyn Future<Output = io::Result<()>> + Send + 'timer>>;

/// The wall clock and a timer holding at most one instant on it, which always agree. The system's
/// is each platform's `WallClockTimer`, which fires at its instant across sleep and any change to
/// the clock.
pub trait WallClock: Send + Sync {
    /// The wall clock's reading now.
    fn now(&self) -> SystemTime {
        SystemTime::now()
    }

    /// Arms the timer for `instant`, in place of any instant it held: one already reached fires at
    /// once, and one past what the system can represent is left unarmed, so it never fires. Fails
    /// only when the system refuses the setting.
    fn arm(&self, instant: SystemTime) -> io::Result<()>;

    /// Disarms the timer. Fails only when the system refuses the setting.
    fn disarm(&self) -> io::Result<()>;

    /// Waits until the armed instant may have been reached, at once for a firing no one waited
    /// for, and forever while nothing is armed; the caller compares [`WallClock::now`] with its
    /// instant. Cancel-safe. Fails only when the timer cannot be read.
    fn wait(&self) -> WallClockWait<'_>;
}
