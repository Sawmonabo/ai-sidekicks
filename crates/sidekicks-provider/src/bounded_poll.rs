//! A test's wait on shared state it can only read, polled until the reading holds and bounded, so
//! a failing test reports the reading it last saw rather than its runner's timeout.

use std::fmt::Debug;
use std::time::{Duration, Instant};

/// How long a wait polls before it fails, in real time, so a test on a paused clock is bounded too.
const POLL_BOUND: Duration = Duration::from_secs(10);

/// The pause between two readings.
const POLL_INTERVAL: Duration = Duration::from_millis(10);

/// Reads `read` until `is_reached` holds of its reading and answers that reading. Panics with the
/// last reading once 10 s pass without it holding.
pub(crate) async fn poll_until<Reading: Debug>(
    read: impl Fn() -> Reading,
    is_reached: impl Fn(&Reading) -> bool,
) -> Reading {
    let deadline = Instant::now() + POLL_BOUND;
    loop {
        let reading = read();
        if is_reached(&reading) {
            return reading;
        }
        assert!(
            Instant::now() < deadline,
            "the awaited reading did not hold within {POLL_BOUND:?}; the last one was {reading:#?}"
        );
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}
