//! The continue a person's answer owes a lead the daemon's restart held: run on a task the queue
//! tracks once the answer is recorded, so the answer never waits on a process start, and undone
//! where its resume fails, the lead moved back to the wait the answer ended. A provider's refusal
//! is posted on the session as its provider warning; a failure on the daemon's side halts the run
//! in the recovery status the Runtime page shows, a reconcile that fails after the resume leaving
//! the run running as the provider has it.

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

/// Where a run whose continue failed is marked as needing the person: the recovery status's
/// halted runs.
pub trait HaltedRunRecord: Send + Sync {
    /// Marks `run` of `session_id` halted; a run marked again takes its newest mark.
    fn halt_run(&self, session_id: &SessionId, run: DaemonRecoveryHaltedRun);
}

impl RunQueue {
    /// Continues `session_id`'s lead with the answers the person gave while the daemon's restart
    /// held it, on a task the queue's stop waits for, once none is still owed it, then hands it
    /// the messages that waited while no process held its session. A resume that fails moves
    /// `run_id`, which the answer moved to `running`, back to `waiting`, the wait the answer
    /// ended, and halts it in the recovery status, but for the provider's refusal, which the
    /// resume posts on the session. A hand that fails after the resume leaves the run running and
    /// halts it as the daemon's own failure.
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
            if let Err(failure) = queue
                .provider_sessions
                .resume_after_answer(session_id)
                .await
            {
                tracing::warn!(
                    session_id = %session_id,
                    run_id = %run_id,
                    error = &failure as &(dyn Error + 'static),
                    "the continue after an orphaned answer failed"
                );
                if failure.provider_refusal().is_none() {
                    queue.halt(
                        session_id,
                        run_id,
                        RunFailureCategory::LocalPersistenceFailure,
                    );
                }
                queue.restore_wait(run_id, waiting).await;
                return;
            }
            let reconciled = match queue.lifecycle.reconcile(session_id).await {
                Ok(reconciled) => reconciled,
                Err(_dropped) => Err(QueueError::DrainEnded),
            };
            // The provider runs the lead on with its answers, so the run stays running.
            if let Err(failure) = reconciled {
                tracing::warn!(
                    session_id = %session_id,
                    run_id = %run_id,
                    error = &failure as &(dyn Error + 'static),
                    "the messages that waited for a continued lead were not handed"
                );
                queue.halt(
                    session_id,
                    run_id,
                    RunFailureCategory::LocalPersistenceFailure,
                );
            }
        });
    }

    // Marks `run_id` halted in the recovery status, failed under `failure_category`.
    fn halt(&self, session_id: SessionId, run_id: RunId, failure_category: RunFailureCategory) {
        self.halted_runs.halt_run(
            &session_id,
            DaemonRecoveryHaltedRun {
                run_id,
                recovery_condition: RecoveryCondition::RecoveryNeeded,
                failure_category: Some(failure_category),
            },
        );
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
