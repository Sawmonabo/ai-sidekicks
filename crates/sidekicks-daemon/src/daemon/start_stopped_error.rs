//! The end of a start that a stop cut short before the daemon listened: what the start had taken is
//! let go, and what it had written stays as it was, so the next start goes on from there.

/// A start's end when a stop came before it listened, naming the step the stop ended.
#[derive(Debug, thiserror::Error)]
#[error("A stop came while the start was {step}")]
pub(crate) struct DaemonStartStoppedError {
    /// What the start was doing when the stop came, such as `repairing the database file`.
    pub(crate) step: &'static str,
}
