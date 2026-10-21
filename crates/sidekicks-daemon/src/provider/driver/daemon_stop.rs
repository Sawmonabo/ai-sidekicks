//! What the daemon's stop or restart means for the lasting services a driver keeps.

/// Why the daemon stops: a restart, after which the daemon starts again and a service that
/// outlives it keeps running, or a stop, which ends that service too.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's stop and restart hand their intent to each driver"
    )
)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DaemonStopIntent {
    /// The daemon starts again: a service that outlives it keeps running.
    Restart,
    /// The daemon stops: every service it started ends.
    Stop,
}
