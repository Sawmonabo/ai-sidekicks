//! The interrupts a restart found pending on a run whose provider kept its turn, handed again
//! through the live path once the run's conversation is resumed. For a person's, the queue's hold,
//! which lived in memory and ended with the old process, is taken again, a `requested` row is
//! accepted against the run as a live request is, and an `accepted` row is dispatched as its
//! accept left it; a limit's `accepted` row, whose hand ended with the old process, is carried out
//! once as its live hand would. An undo's row is handed nothing: the undo it served ended with the
//! old process, so its turn runs on. A row the hand leaves pending, or one handed nothing, is
//! settled by the run's end or the turn's end.

use std::error::Error;

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::{
    AgentRunInterveneRequest, InterruptInterventionRecord, InterventionInterruptRequest,
    InterventionType,
};
use sidekicks_std::settle_all::{SettleFailures, settle_all};
use sidekicks_store::database::connection::read_pool::ReadLength;

use crate::interventions::service::errors::InterventionError;
use crate::interventions::service::request::{interrupt_choice_of, person_request_of};
use crate::interventions::service::{InterventionService, InterventionTarget};
use crate::interventions::store::UnresolvedInterventionState;
use crate::run::restart::{PendingInterrupt, read_pending_interrupts};

impl InterventionService {
    /// Hands again, on the engine's interrupt hand carrying the caller's span, each interrupt
    /// pending on `run_id`, a person's or a limit's, an undo's handed nothing, whose provider runs
    /// its turn again after a restart; a failure is logged, and a row left pending, a hand the
    /// daemon's stop cut among them, is settled by the run's end. Spawned, since the resume that
    /// calls it holds the session while the run's end goes through the run queue.
    pub fn hand_pending_interrupts_again(&self, run_id: RunId) {
        let service = self.clone();
        self.engine.hand_interrupt(run_id, async move {
            if let Err(error) = service.carry_out_pending_interrupts(run_id).await {
                tracing::warn!(
                    run_id = %run_id,
                    error = &error as &(dyn Error + 'static),
                    "an interrupt pending at the restart could not be handed again; the run's end \
                     settles it"
                );
            }
        });
    }

    /// Carries out each interrupt pending on `run_id`, oldest first, each under the run's interrupt
    /// lock, through the live path: a person's as its request would go, a limit's as its live hand
    /// would, recording its own failure; an undo's is left for the turn's end. Each row's state is
    /// read again under the lock, so one the live path carried out meanwhile is not sent again.
    /// Every row is tried, and the person's failures are returned together.
    pub(super) async fn carry_out_pending_interrupts(
        &self,
        run_id: RunId,
    ) -> Result<(), InterventionError> {
        let pending = self.read_pending(run_id).await?;
        if pending.is_empty() {
            return Ok(());
        }
        let session_id = self.require_run(run_id).await?.session_id;
        let mut handed = Vec::new();
        for intervention_id in pending.into_iter().map(|row| row.intervention_id) {
            let _hold = self.interrupt_lock.acquire(run_id).await;
            let still_pending = match self.read_pending(run_id).await {
                Ok(rows) => rows,
                Err(failure) => {
                    handed.push(Err(failure));
                    continue;
                }
            };
            let Some(PendingInterrupt {
                intervention_id,
                state,
                actor,
                record,
                expected_run_version,
                client_idempotency_key,
            }) = still_pending
                .into_iter()
                .find(|row| row.intervention_id == intervention_id)
            else {
                continue;
            };
            let target = InterventionTarget {
                session_id,
                intervention_id,
                target_run_id: run_id,
                intervention_type: InterventionType::Interrupt,
                actor,
            };
            match record {
                InterruptInterventionRecord::Person(record) => {
                    let interrupt = person_request_of(
                        run_id,
                        expected_run_version,
                        client_idempotency_key,
                        record,
                    );
                    handed.push(self.hand_again(&target, state, interrupt).await);
                }
                // A limit's row is only ever written `accepted`, so its state is not read.
                InterruptInterventionRecord::Limit(record) => {
                    self.hand_limit_interrupt_again(
                        target,
                        record,
                        i64::from(expected_run_version),
                    )
                    .await;
                }
                // The pending read leaves an undo's row out: its undo ended with the old process,
                // so no cut would follow a stop handed now.
                InterruptInterventionRecord::Undo(_) => {}
            }
        }
        match settle_all(handed, "handing the pending interrupts again") {
            Ok(_) => Ok(()),
            Err(SettleFailures::One(failure)) => Err(failure),
            Err(many @ SettleFailures::Many { .. }) => {
                Err(InterventionError::Several(Box::new(many)))
            }
        }
    }

    // The interrupts pending on `run_id`, oldest first.
    async fn read_pending(
        &self,
        run_id: RunId,
    ) -> Result<Vec<PendingInterrupt>, InterventionError> {
        self.pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, InterventionError>(read_pending_interrupts(reader, &run_id)?)
            })
            .await
    }

    // Takes the run queue's hold for the person's `interrupt` that `target` names, carries its
    // row out from `state` and lets the hold go as a live request does; the caller holds the run's
    // interrupt lock.
    async fn hand_again(
        &self,
        target: &InterventionTarget,
        state: UnresolvedInterventionState,
        interrupt: InterventionInterruptRequest,
    ) -> Result<(), InterventionError> {
        let choice = interrupt_choice_of(&interrupt);
        let request = AgentRunInterveneRequest::Interrupt(interrupt);
        // The hold lived in memory and ended with the old process, so it is taken again before
        // the row moves, as a live request takes it before its row.
        self.queue
            .hold_for_interrupt(target.target_run_id, target.intervention_id, choice)
            .await
            .map_err(InterventionError::Queue)?;
        let applied = match state {
            UnresolvedInterventionState::Requested => self.accept_and_apply(target, &request).await,
            UnresolvedInterventionState::Accepted => {
                let dispatched = self.dispatch_once(target, &request).await;
                self.settle_dispatched(target, &request, dispatched).await
            }
        };
        self.release_unless_settled(target, choice, applied)
            .await
            .map(drop)
    }
}
