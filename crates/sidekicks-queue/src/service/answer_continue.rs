//! The continue a person's answer owes a lead the daemon's restart held: run on a task the queue
//! tracks once the answer is recorded, so the answer never waits on a process start, and undone
//! where its resume fails before the provider carried it, the lead moved back to the wait the
//! answer ended. A provider's refusal
//! is posted on the session as its provider warning; its failure to continue is posted the same
//! way and halts the run as the provider's failure, and a failure on the daemon's side halts it as
//! the daemon's own, in the recovery status the Runtime page shows; a failure after the provider
//! carried the continue, its settle's or the reconcile's, leaves the run running as the provider
//! has it. A paused helper the person continued under a lead the restart holds is such an answer:
//! its kept messages go into the lead's continue as its words. A held lead the person continued
//! waits for the answer that frees it, its kept messages going into that continue as its words,
//! and a failed continue moves it back to `paused`, its messages kept.

use std::error::Error;
use std::sync::Weak;

use sidekicks_contracts::daemon::recovery::DaemonRecoveryHaltedRun;
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::run::control::RunFailureCategory;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::run::state_entry::RunStateEntry;
use sidekicks_session::run::state_change::{RunStateChange, RunWriteCompanions};

use super::RunQueue;
use crate::delivery::HeldLeadContinuation;
use crate::error::QueueError;
use crate::provider_session::held_run_continue::ContinuedWords;

impl HeldLeadContinuation for Weak<RunQueue> {
    // The helper's continue is an answer's: a failed one moves it back to `paused`, words kept.
    fn continue_held_lead(&self, session_id: SessionId, helper_run_id: RunId) {
        if let Some(queue) = self.upgrade() {
            queue.continue_after_answer(session_id, helper_run_id, RunStateEntry::Paused);
        }
    }
}

/// Where a run whose continue failed is marked as needing the person: the recovery status's
/// halted runs.
pub trait HaltedRunRecord: Send + Sync {
    /// Marks `run` of `session_id` halted; a run marked again takes its newest mark.
    fn halt_run(&self, session_id: &SessionId, run: DaemonRecoveryHaltedRun);
}

impl RunQueue {
    /// Continues `session_id`'s lead with the answers the person gave while the daemon's restart
    /// held it, and the words each paused run the person continued kept, a helper beneath it or
    /// the lead itself, on a task the queue's stop waits for, once none is still owed it, then
    /// hands it the messages that waited while no process held its session. A resume that fails
    /// moves `run_id`, which the answer moved to `running`, back to `waiting`, the wait the answer
    /// ended, or a continued helper back to `paused` with its words kept, and a held lead the
    /// person continued back to `paused` with its words kept, and halts `run_id` in the recovery
    /// status under its failure's category, but for the provider's refusal, which the resume posts
    /// on the session. A resume that fails after its
    /// provider carried the continue, or a hand that fails after the resume, leaves the run
    /// running and halts it as the daemon's own failure.
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
            let continued_words = match queue.delivery.kept_words(session_id).await {
                Ok(kept) => ContinuedWords {
                    kept,
                    messages: &queue.delivery,
                },
                Err(failure) => {
                    tracing::warn!(
                        session_id = %session_id,
                        run_id = %run_id,
                        error = &*failure as &(dyn Error + 'static),
                        "the words continued helpers kept could not be read"
                    );
                    queue.halt(
                        session_id,
                        run_id,
                        RunFailureCategory::LocalPersistenceFailure,
                    );
                    queue.restore_continue(session_id, run_id, waiting).await;
                    return;
                }
            };
            if let Err(failure) = queue
                .provider_sessions
                .resume_after_answer(session_id, &continued_words)
                .await
            {
                // The provider runs the lead on with its answers, so the run stays running.
                if failure.is_after_carried_continue() {
                    tracing::warn!(
                        session_id = %session_id,
                        run_id = %run_id,
                        error = &failure as &(dyn Error + 'static),
                        "a continued lead's runs were not settled"
                    );
                    queue.halt(
                        session_id,
                        run_id,
                        RunFailureCategory::LocalPersistenceFailure,
                    );
                    return;
                }
                tracing::warn!(
                    session_id = %session_id,
                    run_id = %run_id,
                    error = &failure as &(dyn Error + 'static),
                    "the continue after an orphaned answer failed"
                );
                if let Some(failure_category) = failure.continue_halt_category() {
                    queue.halt(session_id, run_id, failure_category);
                }
                queue.restore_continue(session_id, run_id, waiting).await;
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

    // Moves `run_id` back to `waiting`, then the held lead of `session_id` a person's continue
    // moved to `running`, which the failed continue was to carry, back to `paused`, its kept
    // messages kept; while a process holds the session the lead runs there and is left.
    async fn restore_continue(&self, session_id: SessionId, run_id: RunId, waiting: RunStateEntry) {
        self.restore_wait(run_id, waiting).await;
        if self.delivery.has_live_process(session_id) {
            return;
        }
        match self
            .provider_sessions
            .read_held_continued_lead(session_id)
            .await
        {
            Ok(Some(lead_run_id)) if lead_run_id != run_id => {
                self.restore_wait(lead_run_id, RunStateEntry::Paused).await;
            }
            Ok(_) => {}
            Err(failure) => tracing::warn!(
                session_id = %session_id,
                error = &failure as &(dyn Error + 'static),
                "a held lead whose continue failed could not be read to move it back to its pause"
            ),
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
                RunWriteCompanions::default(),
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
