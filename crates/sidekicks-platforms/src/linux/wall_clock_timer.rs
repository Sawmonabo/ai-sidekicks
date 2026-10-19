//! The wall clock's timer on Linux: a `CLOCK_REALTIME` timerfd armed with `TFD_TIMER_ABSTIME |
//! TFD_TIMER_CANCEL_ON_SET`, which fires at its instant across sleep and across any clock set. A
//! clock set or a resume refuses the next read with `ECANCELED` and drops any firing the set
//! brought, so the wait arms the same instant again, which fires at once when the clock has already
//! passed it; `ECANCELED` is never taken as a wake, which logind tells.

use std::io;
use std::os::fd::{AsFd, AsRawFd, RawFd};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use nix::errno::Errno;
use nix::sys::time::TimeSpec;
use nix::sys::timerfd::{ClockId, Expiration, TimerFd, TimerFlags, TimerSetTimeFlags};
use tokio::io::unix::AsyncFd;

use crate::wall_clock::{WallClock, WallClockWait};

// The earliest instant the timer takes: an expiry of zero would disarm it instead.
const EARLIEST_EXPIRY: Duration = Duration::from_nanos(1);

/// The system's wall clock and its timer on Linux.
pub struct WallClockTimer {
    timer: AsyncFd<TimerDescriptor>,
    // The instant armed, to arm again after a clock set; held across each setting, so a wait never
    // arms an instant replaced meanwhile.
    armed_expiry: Mutex<Option<TimeSpec>>,
}

// The timerfd as tokio's reactor watches it, which takes a raw descriptor `TimerFd` does not give.
struct TimerDescriptor(TimerFd);

impl AsRawFd for TimerDescriptor {
    fn as_raw_fd(&self) -> RawFd {
        self.0.as_fd().as_raw_fd()
    }
}

// What one read of the timer found.
enum TimerRead {
    Fired,
    ClockSet,
}

impl WallClockTimer {
    /// A timer armed for no instant, read through the running tokio runtime. Fails when the
    /// process has no descriptor left or the runtime cannot watch it.
    pub fn new() -> io::Result<Self> {
        let timer = TimerFd::new(
            ClockId::CLOCK_REALTIME,
            TimerFlags::TFD_NONBLOCK | TimerFlags::TFD_CLOEXEC,
        )?;
        // SAFETY: the descriptor is the timerfd the `AsyncFd` owns from here, open until the
        // `AsyncFd` drops it, and `as_raw_fd` answers that one descriptor every time.
        let timer = unsafe { AsyncFd::register(TimerDescriptor(timer)) }?;
        Ok(Self {
            timer,
            armed_expiry: Mutex::new(None),
        })
    }

    fn lock_armed_expiry(&self) -> MutexGuard<'_, Option<TimeSpec>> {
        self.armed_expiry
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    // Sets the timer for `expiry`. A clock set still pending refuses the setting with `ECANCELED`
    // though the timer is armed, so that refusal is a success.
    fn set_expiry(&self, expiry: TimeSpec) -> io::Result<()> {
        match self.timer.get_ref().0.set(
            Expiration::OneShot(expiry),
            TimerSetTimeFlags::TFD_TIMER_ABSTIME | TimerSetTimeFlags::TFD_TIMER_CANCEL_ON_SET,
        ) {
            Ok(()) | Err(Errno::ECANCELED) => Ok(()),
            Err(errno) => Err(io::Error::from(errno)),
        }
    }

    // Arms the held instant again after a clock set dropped its firing.
    fn arm_again(&self) -> io::Result<()> {
        let armed_expiry = self.lock_armed_expiry();
        match *armed_expiry {
            Some(expiry) => self.set_expiry(expiry),
            None => Ok(()),
        }
    }
}

impl WallClock for WallClockTimer {
    fn arm(&self, instant: SystemTime) -> io::Result<()> {
        let since_epoch = instant
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .max(EARLIEST_EXPIRY);
        let expiry = TimeSpec::from_duration(since_epoch);
        let mut armed_expiry = self.lock_armed_expiry();
        self.set_expiry(expiry)?;
        *armed_expiry = Some(expiry);
        Ok(())
    }

    fn disarm(&self) -> io::Result<()> {
        let mut armed_expiry = self.lock_armed_expiry();
        self.timer.get_ref().0.unset()?;
        *armed_expiry = None;
        Ok(())
    }

    fn wait(&self) -> WallClockWait<'_> {
        Box::pin(async move {
            loop {
                let mut readiness = self.timer.readable().await?;
                match readiness.try_io(|timer| read_timer(&timer.get_ref().0)) {
                    Ok(Ok(TimerRead::Fired)) => return Ok(()),
                    Ok(Ok(TimerRead::ClockSet)) => self.arm_again()?,
                    Ok(Err(failure)) => return Err(failure),
                    // Not readable after all: the readiness is cleared and the wait goes on.
                    Err(_would_block) => {}
                }
            }
        })
    }
}

// Reads the timer's expiry count, which a clock set or a resume refuses with `ECANCELED`.
fn read_timer(timer: &TimerFd) -> io::Result<TimerRead> {
    let mut expiry_count = [0_u8; 8];
    match nix::unistd::read(timer, &mut expiry_count) {
        Ok(_) => Ok(TimerRead::Fired),
        Err(Errno::ECANCELED) => Ok(TimerRead::ClockSet),
        Err(errno) => Err(io::Error::from(errno)),
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant, SystemTime};

    use nix::sys::time::TimeSpec;
    use nix::time::{ClockId, clock_settime};

    use super::WallClockTimer;
    use crate::wall_clock::WallClock;

    // Set only by the container the clock-set test runs in, since setting the clock is not confined
    // to a namespace and would move the clock of any machine that ran it.
    const CLOCK_SET_CONTAINER_VARIABLE: &str = "SIDEKICKS_CLOCK_SET_CONTAINER";

    // How far ahead the timer is armed, the clock set short of it, and the clock set past it.
    const ARMED_AHEAD: Duration = Duration::from_secs(120);
    const SET_SHORT: Duration = Duration::from_secs(60);
    const SET_PAST: Duration = Duration::from_secs(121);

    // How long the timer is watched for a firing it must not report, and how long a firing it must
    // report may take.
    const QUIET_SPAN: Duration = Duration::from_secs(2);
    const FIRING_BOUND: Duration = Duration::from_secs(5);

    fn set_wall_clock(instant: SystemTime) {
        let since_epoch = instant
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("the clock reads after 1970");
        clock_settime(
            ClockId::CLOCK_REALTIME,
            TimeSpec::from_duration(since_epoch),
        )
        .expect("the test may set the clock");
    }

    #[tokio::test]
    #[ignore = "sets the clock, so it runs only in the container that sets its variable"]
    async fn the_timer_reports_its_instant_only_once_the_clock_is_set_past_it() {
        assert!(
            std::env::var_os(CLOCK_SET_CONTAINER_VARIABLE).is_some(),
            "the clock-set test runs only in its container, which sets \
             {CLOCK_SET_CONTAINER_VARIABLE}"
        );
        let started_at = SystemTime::now();
        let started = Instant::now();
        let timer = WallClockTimer::new().expect("a timer is made");
        timer.arm(started_at + ARMED_AHEAD).expect("the timer arms");

        set_wall_clock(started_at + SET_SHORT);
        let early = tokio::time::timeout(QUIET_SPAN, timer.wait()).await;
        set_wall_clock(started_at + started.elapsed() + SET_PAST);
        let firing = tokio::time::timeout(FIRING_BOUND, timer.wait()).await;
        set_wall_clock(started_at + started.elapsed());

        assert!(
            early.is_err(),
            "a clock set short of the instant reports nothing"
        );
        firing
            .expect("the timer reports the instant once the clock is past it")
            .expect("the timer reads");
    }
}
