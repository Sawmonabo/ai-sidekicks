//! A person's interrupt a restart found pending on a run whose provider kept its turn, handed
//! again through the live path once the run's conversation is resumed: the queue's hold, which
//! lived in memory and ended with the old process, is taken again, a `requested` row is accepted
//! against the run as a live request is, and an `accepted` row is dispatched as its accept left
//! it. A row the hand leaves pending is settled by the run's end.

use std::error::Error;

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::{
    AgentRunInterveneRequest, InterruptInterventionRecord, InterventionInterruptRequest,
    InterventionType,
};
use sidekicks_std::settle_all::{SettleFailures, settle_all};
use sidekicks_store::database::connection::read_pool::ReadLength;
use tracing::Instrument as _;

use crate::interventions::service::errors::InterventionError;
use crate::interventions::service::request::{interrupt_choice_of, person_request_of};
use crate::interventions::service::{InterventionService, InterventionTarget};
use crate::interventions::store::UnresolvedInterventionState;
use crate::run::restart::{PendingInterrupt, read_pending_interrupts};

impl InterventionService {
    /// Hands again, on a task of its own carrying the caller's span, each of the person's
    /// interrupts pending on `run_id`, whose provider runs its turn again after a restart; a
    /// failure is logged, and a row left pending is settled by the run's end. Spawned, since the
    /// resume that calls it holds the session while the run's end goes through the run queue.
    pub fn hand_pending_interrupts_again(&self, run_id: RunId) {
        let service = self.clone();
        tokio::spawn(
            async move {
                if let Err(error) = service.carry_out_pending_interrupts(run_id).await {
                    tracing::warn!(
                        run_id = %run_id,
                        error = &error as &(dyn Error + 'static),
                        "a person's interrupt pending at the restart could not be handed again; \
                         the run's end settles it"
                    );
                }
            }
            .instrument(tracing::Span::current()),
        );
    }

    /// Carries out each of the person's interrupts pending on `run_id`, oldest first, each under
    /// the run's interrupt lock, through the live path; a limit's row is left to the engine's own
    /// hand. Every row is tried, and the failures are returned together.
    pub(super) async fn carry_out_pending_interrupts(
        &self,
        run_id: RunId,
    ) -> Result<(), InterventionError> {
        let pending = self
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, InterventionError>(read_pending_interrupts(reader, &run_id)?)
            })
            .await?;
        if pending.is_empty() {
            return Ok(());
        }
        let session_id = self.require_run(run_id).await?.session_id;
        let mut handed = Vec::new();
        for PendingInterrupt {
            intervention_id,
            state,
            actor,
            record,
            expected_run_version,
            client_idempotency_key,
        } in pending
        {
            // A limit's row is the engine's own hand.
            let InterruptInterventionRecord::Person(record) = record else {
                continue;
            };
            let target = InterventionTarget {
                session_id,
                intervention_id,
                target_run_id: run_id,
                intervention_type: InterventionType::Interrupt,
                actor,
            };
            let interrupt =
                person_request_of(run_id, expected_run_version, client_idempotency_key, record);
            let _hold = self.interrupt_lock.acquire(run_id).await;
            handed.push(self.hand_again(&target, state, interrupt).await);
        }
        match settle_all(handed, "handing a person's pending interrupts again") {
            Ok(_) => Ok(()),
            Err(SettleFailures::One(failure)) => Err(failure),
            Err(many @ SettleFailures::Many { .. }) => {
                Err(InterventionError::Several(Box::new(many)))
            }
        }
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
