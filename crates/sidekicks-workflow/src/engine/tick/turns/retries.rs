//! The timers of retry attempts waiting out their wait: each armed on the tick's set, answering
//! its attempt once the wait has passed, or nothing once its run's cancel fires first; and what a
//! restart leaves of a wait begun before the stop.

use std::time::Duration;

use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use tokio::task::{JoinError, JoinSet};
use tokio_util::sync::CancellationToken;

/// Arms on `retries` the timer that answers `attempt` once `wait` has passed, or nothing once its
/// run's `cancel` fires first.
pub(super) fn arm_retry(
    retries: &mut JoinSet<Option<WorkflowStepKey>>,
    attempt: WorkflowStepKey,
    wait: Duration,
    cancel: CancellationToken,
) {
    retries.spawn(async move {
        tokio::select! {
            () = tokio::time::sleep(wait) => Some(attempt),
            () = cancel.cancelled() => None,
        }
    });
}

/// The attempt a retry's `timer` answers come due, `None` when its run was canceled first. A
/// timer's panic is raised again here, since nothing aborts a timer while the tick lives.
pub(super) fn retry_due(
    timer: Result<Option<WorkflowStepKey>, JoinError>,
) -> Option<WorkflowStepKey> {
    match timer {
        Ok(due) => due,
        Err(error) => std::panic::resume_unwind(error.into_panic()),
    }
}

/// What is left at the restart of a retry's `wait` begun at `readied_at`, zero once it has passed.
pub(super) fn retry_wait_left(readied_at: &WireInstant, wait: Duration) -> Duration {
    let elapsed = readied_at
        .timestamp()
        .and_then(|at| Duration::try_from(jiff::Timestamp::now().duration_since(at)).ok())
        .unwrap_or(Duration::ZERO);
    wait.saturating_sub(elapsed)
}
