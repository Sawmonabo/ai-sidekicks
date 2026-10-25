//! The cadence a task is polled at: one `tasks/get` at a time, 2 s apart unless the server suggests
//! its own interval, which is held between 250 ms and 30 s. A poll that fails is polled again at
//! the same cadence, the task left alone; once no poll was answered for 300 s the task's contact
//! reads lost, and the next answered poll reads it reached again. A status notification only
//! wakes the next poll early, never sooner than 250 ms after the last one, so a server flooding
//! notifications cannot drive polls back to back; the poll alone decides the task's state.

use std::future::Future;
use std::time::Duration;

use tokio::sync::{Notify, watch};
use tokio::time::Instant;

use crate::mcp::client::tasks::McpTaskContact;

/// The interval between polls when the server suggests none.
pub(super) const DEFAULT_POLL_INTERVAL: Duration = Duration::from_secs(2);

/// The shortest interval a server's suggestion is held to.
pub(super) const MIN_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// The longest interval a server's suggestion is held to.
pub(super) const MAX_POLL_INTERVAL: Duration = Duration::from_secs(30);

/// How long no poll may be answered before the task's contact reads lost.
pub(super) const CONTACT_LOST_AFTER: Duration = Duration::from_secs(300);

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

/// The wait before the next poll: the server's suggestion held between the bounds, else the
/// default.
pub(super) fn poll_interval(suggested_interval_ms: Option<u64>) -> Duration {
    suggested_interval_ms.map_or(DEFAULT_POLL_INTERVAL, |milliseconds| {
        Duration::from_millis(milliseconds).clamp(MIN_POLL_INTERVAL, MAX_POLL_INTERVAL)
    })
}

/// Polls with `poll` until it reads the end, waiting the held interval between polls, or less
/// when `wake` is notified but at least [`MIN_POLL_INTERVAL`] from the last poll, and keeping `contact` to whether a poll was answered within 300 s. The
/// first poll runs at once.
pub(super) async fn follow_task<End, Error, Poll, Polled>(
    wake: &Notify,
    contact: &watch::Sender<McpTaskContact>,
    mut poll: Poll,
) -> End
where
    Error: std::error::Error + 'static,
    Poll: FnMut() -> Polled,
    Polled: Future<Output = Result<PollStep<End>, Error>>,
{
    let mut last_answered = Instant::now();
    let mut interval = DEFAULT_POLL_INTERVAL;
    loop {
        let polled_at = Instant::now();
        match poll().await {
            Ok(PollStep::End(end)) => {
                contact.send_if_modified(reach);
                return end;
            }
            Ok(PollStep::Wait {
                suggested_interval_ms,
            }) => {
                last_answered = Instant::now();
                contact.send_if_modified(reach);
                interval = poll_interval(suggested_interval_ms);
            }
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "a tool server task poll failed"
                );
                if last_answered.elapsed() >= CONTACT_LOST_AFTER {
                    contact.send_if_modified(|state| {
                        let is_new = *state != McpTaskContact::Lost;
                        *state = McpTaskContact::Lost;
                        is_new
                    });
                }
            }
        }
        tokio::select! {
            () = tokio::time::sleep(interval) => {}
            () = wake.notified() => {
                tokio::time::sleep_until(polled_at + MIN_POLL_INTERVAL).await;
            }
        }
    }
}

// Marks the task's server reached; true when that changed the state.
fn reach(state: &mut McpTaskContact) -> bool {
    let is_new = *state != McpTaskContact::Reached;
    *state = McpTaskContact::Reached;
    is_new
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
