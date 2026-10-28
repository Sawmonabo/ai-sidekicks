//! Work on one worktree or kept copy run under its key in a task of its own: the answer it lands,
//! and the service-log line for work that ended after its caller stopped waiting.

use std::error::Error;

use sidekicks_contracts::worktree::lifecycle::{RemovedWorktreeId, WorktreeId};
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

/// The answer of work run under a key, as the lock's `run_held` hands it back; an end without an
/// answer becomes `Failure` through its `HeldWorkEnd` conversion.
pub(crate) fn held_answer<Answer, Failure: From<HeldWorkEnd>>(
    landed: Result<Option<Result<Answer, Failure>>, JoinError>,
) -> Result<Answer, Failure> {
    match landed {
        Ok(Some(answer)) => answer,
        Ok(None) => Err(HeldWorkEnd::Unanswered.into()),
        Err(interrupted) => Err(HeldWorkEnd::Interrupted(interrupted).into()),
    }
}

/// The worktree or kept copy held work runs on, named in the service log by its own field.
#[derive(Clone, Copy, Debug)]
pub(crate) enum HeldWorkSubject {
    /// A worktree, by its id.
    Worktree(WorktreeId),
    /// A kept copy, by its id.
    KeptCopy(RemovedWorktreeId),
}

/// What writes the outcome of `operation` on `subject` to the service log when it ended after its
/// caller stopped waiting: `info` on success, `error` with the failure.
pub(crate) fn log_landed_late<Answer: 'static, Failure: Error + 'static>(
    operation: &'static str,
    subject: HeldWorkSubject,
) -> impl FnOnce(&Result<Answer, Failure>) + Send + 'static {
    move |answer| {
        // At the error level, so the subject's field stays on both lines under any filter that
        // keeps the error line.
        let span = match subject {
            HeldWorkSubject::Worktree(worktree_id) => {
                tracing::error_span!("held_work", worktree_id = %worktree_id)
            }
            HeldWorkSubject::KeptCopy(removed_worktree_id) => {
                tracing::error_span!("held_work", removed_worktree_id = %removed_worktree_id)
            }
        };
        let _entered = span.enter();
        match answer {
            Ok(_) => tracing::info!(
                operation,
                "work on a worktree finished after its caller stopped waiting"
            ),
            Err(failure) => tracing::error!(
                operation,
                error = failure as &(dyn Error + 'static),
                "work on a worktree failed after its caller stopped waiting"
            ),
        }
    }
}
