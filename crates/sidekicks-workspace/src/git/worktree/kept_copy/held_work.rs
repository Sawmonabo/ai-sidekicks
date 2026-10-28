//! Work on one kept copy run under its lock: the answer it lands, and the service-log line for work
//! that ended after its caller stopped waiting.

use std::error::Error;

use sidekicks_contracts::worktree::lifecycle::RemovedWorktreeId;
use tokio::task::JoinError;

/// How held work ended without answering: skipped once its caller stopped waiting, or its task
/// ended before it finished.
#[derive(Debug)]
pub(crate) enum HeldWorkEnd {
    /// The work was skipped, since its caller stopped waiting before the lock was held.
    Unanswered,
    /// The task that ran the work ended before it finished.
    Interrupted(JoinError),
}

/// The answer of work run under the kept copy's lock, as the lock's `run_held` hands it back; an
/// end without an answer becomes `Failure` through its `HeldWorkEnd` conversion.
pub(crate) fn held_answer<Answer, Failure: From<HeldWorkEnd>>(
    landed: Result<Option<Result<Answer, Failure>>, JoinError>,
) -> Result<Answer, Failure> {
    match landed {
        Ok(Some(answer)) => answer,
        Ok(None) => Err(HeldWorkEnd::Unanswered.into()),
        Err(interrupted) => Err(HeldWorkEnd::Interrupted(interrupted).into()),
    }
}

/// What writes the outcome of `operation` on the kept copy `removed_worktree_id` to the service
/// log when it ended after its caller stopped waiting: `info` on success, `error` with the failure.
pub(crate) fn log_landed_late<Answer: 'static, Failure: Error + 'static>(
    operation: &'static str,
    removed_worktree_id: RemovedWorktreeId,
) -> impl FnOnce(&Result<Answer, Failure>) + Send + 'static {
    move |answer| match answer {
        Ok(_) => tracing::info!(
            removed_worktree_id = %removed_worktree_id,
            operation,
            "a kept worktree's work finished after its caller stopped waiting"
        ),
        Err(failure) => tracing::error!(
            removed_worktree_id = %removed_worktree_id,
            operation,
            error = failure as &(dyn Error + 'static),
            "a kept worktree's work failed after its caller stopped waiting"
        ),
    }
}
