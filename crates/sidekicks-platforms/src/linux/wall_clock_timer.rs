//! A timer for an instant on the wall clock on Linux: a `CLOCK_REALTIME` timerfd armed with
//! `TFD_TIMER_ABSTIME | TFD_TIMER_CANCEL_ON_SET`, as systemd's event loop arms one. It fires at the
//! instant across sleep and across any clock set; a clock set or a resume also ends its wait early
//! (`ECANCELED`), after which the caller compares the clock and arms again.

use std::io;
use std::os::fd::{AsFd, AsRawFd, RawFd};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use nix::errno::Errno;
use nix::sys::time::TimeSpec;
use nix::sys::timerfd::{ClockId, Expiration, TimerFd, TimerFlags, TimerSetTimeFlags};
use tokio::io::unix::AsyncFd;

// The earliest instant the timer takes: an expiry of zero would disarm it instead.
const EARLIEST_EXPIRY: Duration = Duration::from_nanos(1);

/// A timer that fires once at an instant on the wall clock, kept by the operating system across
/// sleep and clock changes; it holds at most one instant.
pub struct WallClockTimer {
    timer: AsyncFd<TimerDescriptor>,
}

// The timerfd as tokio's reactor watches it, which takes a raw descriptor `TimerFd` does not give.
struct TimerDescriptor(TimerFd);

impl AsRawFd for TimerDescriptor {
    fn as_raw_fd(&self) -> RawFd {
        self.0.as_fd().as_raw_fd()
    }
}

impl WallClockTimer {
    /// A timer armed for no instant, read through the running tokio runtime. Fails when the
    /// process has no descriptor left or the runtime cannot watch it.
    pub fn new() -> io::Result<Self> {
        let timer = TimerFd::new(
            ClockId::CLOCK_REALTIME,
            TimerFlags::TFD_NONBLOCK | TimerFlags::TFD_CLOEXEC,
        )?;
        Ok(Self {
            timer: AsyncFd::new(TimerDescriptor(timer))?,
        })
    }

    /// Arms the timer for `instant`, in place of any instant it held; one already past fires at
    /// once. Fails only when the system refuses the setting.
    pub fn arm(&mut self, instant: SystemTime) -> io::Result<()> {
        let since_epoch = instant
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .max(EARLIEST_EXPIRY);
        self.timer.get_ref().0.set(
            Expiration::OneShot(TimeSpec::from_duration(since_epoch)),
            TimerSetTimeFlags::TFD_TIMER_ABSTIME | TimerSetTimeFlags::TFD_TIMER_CANCEL_ON_SET,
        )?;
        Ok(())
    }

    /// Disarms the timer. Fails only when the system refuses the setting.
    pub fn disarm(&mut self) -> io::Result<()> {
        self.timer.get_ref().0.unset()?;
        Ok(())
    }

    /// Waits until the armed instant may have passed, or the clock was set or the machine resumed;
    /// the caller compares the wall clock and arms again. Cancel-safe. Fails only when the timer
    /// cannot be read.
    pub async fn wait(&mut self) -> io::Result<()> {
        loop {
            let mut readiness = self.timer.readable().await?;
            if let Ok(read) = readiness.try_io(|timer| read_expiry(&timer.get_ref().0)) {
                return read;
            }
        }
    }
}

// Reads the timer's expiry count, which a clock set or a resume refuses with `ECANCELED`; both end
// the wait.
fn read_expiry(timer: &TimerFd) -> io::Result<()> {
    let mut expiry_count = [0_u8; 8];
    match nix::unistd::read(timer, &mut expiry_count) {
        Ok(_) | Err(Errno::ECANCELED) => Ok(()),
        Err(errno) => Err(io::Error::from(errno)),
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, SystemTime};

    use nix::sys::time::TimeSpec;
    use nix::time::{ClockId, clock_settime};

    use super::WallClockTimer;

    // How far ahead the timer is armed, and how far the clock is set forward past it.
    const ARMED_AHEAD: Duration = Duration::from_secs(120);
    const SET_FORWARD: Duration = Duration::from_secs(121);

    // How long the firing may take once the clock passed the instant.
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
    #[ignore = "sets the machine's clock, so it runs only in a container given CAP_SYS_TIME"]
    async fn a_timer_fires_at_its_instant_once_the_clock_is_set_past_it() {
        let mut timer = WallClockTimer::new().expect("a timer is made");
        let armed_at = SystemTime::now();
        timer.arm(armed_at + ARMED_AHEAD).expect("the timer arms");

        set_wall_clock(SystemTime::now() + SET_FORWARD);
        let firing = tokio::time::timeout(FIRING_BOUND, timer.wait()).await;
        let fired_at = SystemTime::now();
        set_wall_clock(SystemTime::now() - SET_FORWARD);

        firing
            .expect("the timer fires within the bound, not at its instant's real time")
            .expect("the timer reads");
        assert!(fired_at >= armed_at + ARMED_AHEAD);
    }
}
