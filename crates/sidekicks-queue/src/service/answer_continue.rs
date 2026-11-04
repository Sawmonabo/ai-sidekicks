//! The continue a person's answer owes a lead the daemon's restart held: run on a task the queue
//! tracks once the answer is recorded, so the answer never waits on a process start, and undone
//! where its resume fails before the provider carried it, the lead moved back to the wait the
//! answer ended. A provider's refusal is posted on the session as its provider warning; its failure
//! to continue is posted the same way and halts the run as the provider's failure, and a failure on
//! the daemon's side halts it as the daemon's own, in the recovery status the Runtime page shows; a
//! failure after the provider carried the continue, its settle's or the reconcile's, leaves the run
//! running as the provider has it. A paused helper the person continued under a lead the restart
//! holds is such an answer: its kept messages go into the lead's continue as its words. A held lead
//! the person continued waits for the answer that frees it, its kept messages going into that
//! continue as its words. A failed continue moves the helper and the held lead back to `paused`,
//! their messages left waiting for the person's next continue.

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
    // The helper's continue is an answer's: a failed one moves it back to `paused`.
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
    /// Continues `session_id`'s lead, on a task the queue's stop waits for, with the answers the
    /// person gave while the daemon's restart held it and the words each paused run the person
    /// continued kept, moving `run_id` back to `waiting` and halting it where the continue fails
    /// before the provider carried it.
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
            // Read before the resume, so a failed continue knows which held lead to move back.
            let held_lead = match queue
                .provider_sessions
                .read_held_continued_lead(session_id)
                .await
            {
                Ok(held_lead) => held_lead.filter(|lead_run_id| *lead_run_id != run_id),
                Err(failure) => {
                    tracing::warn!(
                        session_id = %session_id,
                        run_id = %run_id,
                        error = &failure as &(dyn Error + 'static),
                        "the held lead of a continued run could not be read"
                    );
                    queue.halt(
                        session_id,
                        run_id,
                        RunFailureCategory::LocalPersistenceFailure,
                    );
                    queue
                        .restore_continue(session_id, run_id, waiting, None)
                        .await;
                    return;
                }
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
                    queue
                        .restore_continue(session_id, run_id, waiting, held_lead)
                        .await;
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
                queue
                    .restore_continue(session_id, run_id, waiting, held_lead)
                    .await;
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

    // Moves `run_id` back to `waiting`, a continued helper back to `paused`, then `held_lead`, the
    // lead a person's continue moved to `running` that the failed continue was to carry, back to
    // `paused`; while a process holds the session the lead runs there and is left. A run moved back
    // to `paused` with no process gives back the messages it kept, so its next continue reads them.
    async fn restore_continue(
        &self,
        session_id: SessionId,
        run_id: RunId,
        waiting: RunStateEntry,
        held_lead: Option<RunId>,
    ) {
        let is_paused = matches!(waiting, RunStateEntry::Paused);
        let is_restored = self.restore_wait(run_id, waiting).await;
        if self.delivery.has_live_process(session_id) {
            return;
        }
        let restored_lead = match held_lead {
            Some(lead_run_id) => self
                .restore_wait(lead_run_id, RunStateEntry::Paused)
                .await
                .then_some(lead_run_id),
            None => None,
        };
        let paused = [(is_paused && is_restored).then_some(run_id), restored_lead];
        let _hold = self.session_lock.hold_session(session_id).await;
        for paused_run_id in paused.into_iter().flatten() {
            self.delivery.forget_kept_words(paused_run_id);
        }
    }

    // Moves `run_id` from `running` back to `waiting`, answering whether it moved; a run that
    // moved on since is left as it is, and a move that fails is logged.
    async fn restore_wait(&self, run_id: RunId, waiting: RunStateEntry) -> bool {
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
        match restored {
            Ok(_) => true,
            Err(error) => {
                tracing::warn!(
                    run_id = %run_id,
                    error = &error as &(dyn Error + 'static),
                    "a run whose continue failed was not moved back to its wait"
                );
                false
            }
        }
    }
}
