//! The continue a person's answer owes a lead the daemon's restart held: run on a task the queue
//! tracks once the answer is recorded, so the answer never waits on a process start, and undone
//! where it fails, the lead moved back to the wait the answer ended and its answers owed to the
//! next resume.

use std::error::Error;

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::run::state_entry::RunStateEntry;
use sidekicks_session::run::state_change::{RunStateChange, RunStateChangeCompanions};

use super::RunQueue;
use crate::error::QueueError;

impl RunQueue {
    /// Continues `session_id`'s lead with the answers the person gave while the daemon's restart
    /// held it, on a task the queue's stop waits for, once none is still owed it, then hands it
    /// the messages that waited while no process held its session. A continue that fails gives
    /// its answers back to the next resume (the resume's own refusal does that) and moves
    /// `run_id`, which the answer moved to `running`, back to `waiting`, the wait the answer
    /// ended; the failure is logged.
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
                "the continue after a kept answer failed; the answer is owed to the next resume"
            );
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
