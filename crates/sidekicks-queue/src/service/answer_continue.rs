//! The continue a person's answer owes a lead the daemon's restart held: run on a task the queue
//! tracks once the answer is recorded, so the answer never waits on a process start, and undone
//! where it fails, the lead moved back to the wait the answer ended and its answers owed to the
//! next resume. A provider's refusal is posted on the session as its provider warning; a failure on
//! the daemon's side halts the run in the recovery status the Runtime page shows.

use std::error::Error;

use sidekicks_contracts::daemon::recovery::DaemonRecoveryHaltedRun;
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::run::control::RunFailureCategory;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::run::state_entry::RunStateEntry;
use sidekicks_session::run::state_change::{RunStateChange, RunStateChangeCompanions};

use super::RunQueue;
use crate::error::QueueError;

/// Where a run whose continue failed on the daemon's side is marked as needing the person: the
/// recovery status's halted runs.
pub trait HaltedRunRecord: Send + Sync {
    /// Marks `run` of `session_id` halted; a run marked again takes its newest mark.
    fn halt_run(&self, session_id: &SessionId, run: DaemonRecoveryHaltedRun);
}

impl RunQueue {
    /// Continues `session_id`'s lead with the answers the person gave while the daemon's restart
    /// held it, on a task the queue's stop waits for, once none is still owed it, then hands it
    /// the messages that waited while no process held its session. A continue that fails gives
    /// its answers back to the next resume (the resume's own refusal does that) and moves
    /// `run_id`, which the answer moved to `running`, back to `waiting`, the wait the answer
    /// ended. A refusal by the provider is posted on the session by the resume; any other failure
    /// halts `run_id` in the recovery status.
    pub fn continue_after_answer(
        &self,
        session_id: SessionId,
        run_id: RunId,
        waiting: RunStateEntry,
    ) {
        let queue = self.this.clone();
        self.continues.spawn(async move {
            let Some(queue) = queue.upgrade() else {
                return;
            };
            let Err(failure) = queue.continue_answered_lead(session_id).await else {
                return;
            };
            tracing::warn!(
                session_id = %session_id,
                run_id = %run_id,
                error = &failure as &(dyn Error + 'static),
                "the continue after an orphaned answer failed; it is owed to the next resume"
            );
            let is_provider_refusal = matches!(
                &failure,
                QueueError::ProviderSession(failed) if failed.provider_refusal().is_some()
            );
            if !is_provider_refusal {
                queue.halted_runs.halt_run(
                    &session_id,
                    DaemonRecoveryHaltedRun {
                        run_id,
                        recovery_condition: RecoveryCondition::RecoveryNeeded,
                        failure_category: Some(RunFailureCategory::LocalPersistenceFailure),
                    },
                );
            }
            queue.restore_wait(run_id, waiting).await;
        });
    }

    // The lead's continue and the hand of what waited for it.
    async fn continue_answered_lead(&self, session_id: SessionId) -> Result<(), QueueError> {
        self.provider_sessions
            .resume_after_answer(session_id)
            .await?;
        match self.lifecycle.reconcile(session_id).await {
            Ok(reconciled) => reconciled,
            Err(_dropped) => Err(QueueError::DrainEnded),
        }
    }

    // Moves `run_id` from `running` back to `waiting`; a run that moved on since is left as it is,
    // and a move that fails is logged.
    async fn restore_wait(&self, run_id: RunId, waiting: RunStateEntry) {
        let restored = self
            .engine
            .transition(
                RunStateChange {
                    expected_state: Some(RunState::Running),
                    ..RunStateChange::new(run_id, waiting)
                },
                RunStateChangeCompanions::default(),
            )
            .await;
        if let Err(error) = restored {
            tracing::warn!(
                run_id = %run_id,
                error = &error as &(dyn Error + 'static),
                "a lead whose continue failed was not moved back to its wait"
            );
        }
    }
}
