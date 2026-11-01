//! A wall clock a test sets, for the jobs a scheduler runs at an instant on it.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, SystemTime};

use sidekicks_platforms::{WallClock, WallClockWait};
use tokio::sync::Notify;

use crate::mutex_lock::lock;

/// Where the test's clock starts: far from the epoch, so a test's instants never meet it.
pub const TEST_CLOCK_START: Duration = Duration::from_hours(500_000);

/// A wall clock the test sets, whose timer fires once the clock reaches the armed instant, which
/// refuses to arm while told to, and which counts the scheduler's waits on it, one per turn of its
/// task.
pub struct TestWallClock {
    now: Mutex<SystemTime>,
    armed_instant: Mutex<Option<SystemTime>>,
    is_arm_refused: AtomicBool,
    fired: Notify,
    wait_count: AtomicUsize,
}

impl Default for TestWallClock {
    fn default() -> Self {
        Self {
            now: Mutex::new(SystemTime::UNIX_EPOCH + TEST_CLOCK_START),
            armed_instant: Mutex::new(None),
            is_arm_refused: AtomicBool::new(false),
            fired: Notify::new(),
            wait_count: AtomicUsize::new(0),
        }
    }
}

impl TestWallClock {
    /// Sets the clock to `now`, firing the timer when it reaches the armed instant.
    pub fn set_now(&self, now: SystemTime) {
        *lock(&self.now) = now;
        self.fire_if_reached();
    }

    /// Makes every later arm fail as a system refusing the setting, or succeed again.
    pub fn refuse_arms(&self, is_refused: bool) {
        self.is_arm_refused.store(is_refused, Ordering::Relaxed);
    }

    /// How many times the scheduler waited on the timer.
    pub fn wait_count(&self) -> usize {
        self.wait_count.load(Ordering::Relaxed)
    }

    fn fire_if_reached(&self) {
        let now = self.now();
        let mut armed_instant = lock(&self.armed_instant);
        if armed_instant.is_some_and(|instant| instant <= now) {
            *armed_instant = None;
            self.fired.notify_one();
        }
    }
}

impl WallClock for TestWallClock {
    fn now(&self) -> SystemTime {
        *lock(&self.now)
    }

    fn arm(&self, instant: SystemTime) -> std::io::Result<()> {
        if self.is_arm_refused.load(Ordering::Relaxed) {
            return Err(std::io::Error::other("the test refuses the arm"));
        }
        *lock(&self.armed_instant) = Some(instant);
        self.fire_if_reached();
        Ok(())
    }

    fn disarm(&self) -> std::io::Result<()> {
        *lock(&self.armed_instant) = None;
        Ok(())
    }

    fn wait(&self) -> WallClockWait<'_> {
        self.wait_count.fetch_add(1, Ordering::Relaxed);
        Box::pin(async move {
            self.fired.notified().await;
            Ok(())
        })
    }
}
