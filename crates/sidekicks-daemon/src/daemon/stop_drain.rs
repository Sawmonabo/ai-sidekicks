//! What the daemon's stop reports of its terminals' drain.

use sidekicks_terminal::DrainResult;

/// The service-log line that says how the terminals drained at the stop.
pub(crate) fn describe_drain(drain: DrainResult) -> String {
    format!(
        "The terminals drained at the stop: {} ended, {} killed.",
        drain.drained, drain.forced
    )
}
