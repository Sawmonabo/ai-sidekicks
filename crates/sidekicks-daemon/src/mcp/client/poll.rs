//! The cadence a task is polled at: one `tasks/get` at a time, 2 s apart unless the server suggests
//! its own interval, which is held between 250 ms and 30 s, and a halt after 5 failed polls in a
//! row, the task's handle kept for recovery. A status notification only wakes the next poll early;
//! the poll alone decides the task's state.

use std::future::Future;
use std::time::Duration;

use tokio::sync::Notify;

/// The interval between polls when the server suggests none.
pub(super) const DEFAULT_POLL_INTERVAL: Duration = Duration::from_secs(2);

/// The shortest interval a server's suggestion is held to.
pub(super) const MIN_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// The longest interval a server's suggestion is held to.
pub(super) const MAX_POLL_INTERVAL: Duration = Duration::from_secs(30);

/// How many polls in a row may fail before the task is halted.
pub(super) const MAX_FAILED_POLLS: u32 = 5;

/// What one poll read: wait for the next one, at the interval the server suggested in
/// milliseconds where it did, or the call's end.
pub(super) enum PollStep<End> {
    /// The task is not done.
    Wait {
        /// The server's suggested interval, in milliseconds.
        suggested_interval_ms: Option<u64>,
    },
    /// The task is done.
    End(End),
}

/// How a followed task stopped being polled.
pub(super) enum PollOutcome<End> {
    /// A poll read the call's end.
    Ended(End),
    /// Five polls in a row failed; the handle stays recorded.
    Halted,
}

/// The wait before the next poll: the server's suggestion held between the bounds, else the
/// default.
pub(super) fn poll_interval(suggested_interval_ms: Option<u64>) -> Duration {
    suggested_interval_ms.map_or(DEFAULT_POLL_INTERVAL, |milliseconds| {
        Duration::from_millis(milliseconds).clamp(MIN_POLL_INTERVAL, MAX_POLL_INTERVAL)
    })
}

/// Polls with `poll` until it reads the end or fails five times in a row, waiting the held
/// interval between polls, or less when `wake` is notified. The first poll runs at once.
pub(super) async fn follow_task<End, Error, Poll, Polled>(
    wake: &Notify,
    mut poll: Poll,
) -> PollOutcome<End>
where
    Error: std::error::Error + 'static,
    Poll: FnMut() -> Polled,
    Polled: Future<Output = Result<PollStep<End>, Error>>,
{
    let mut failed_polls = 0;
    let mut interval = DEFAULT_POLL_INTERVAL;
    loop {
        match poll().await {
            Ok(PollStep::End(end)) => return PollOutcome::Ended(end),
            Ok(PollStep::Wait {
                suggested_interval_ms,
            }) => {
                failed_polls = 0;
                interval = poll_interval(suggested_interval_ms);
            }
            Err(error) => {
                failed_polls += 1;
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    failed_polls,
                    "a tool server task poll failed"
                );
                if failed_polls >= MAX_FAILED_POLLS {
                    return PollOutcome::Halted;
                }
            }
        }
        tokio::select! {
            () = tokio::time::sleep(interval) => {}
            () = wake.notified() => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use rstest::rstest;

    use super::{DEFAULT_POLL_INTERVAL, poll_interval};

    // Fails when the server's suggestion is taken unbounded (a removed clamp) or the default is
    // not 2 s.
    #[rstest]
    #[case::none(None, DEFAULT_POLL_INTERVAL)]
    #[case::below_the_floor(Some(10), Duration::from_millis(250))]
    #[case::inside(Some(5_000), Duration::from_secs(5))]
    #[case::past_the_ceiling(Some(120_000), Duration::from_secs(30))]
    fn the_servers_interval_is_held_between_250_ms_and_30_s(
        #[case] suggested: Option<u64>,
        #[case] expected: Duration,
    ) {
        assert_eq!(poll_interval(suggested), expected);
    }
}
