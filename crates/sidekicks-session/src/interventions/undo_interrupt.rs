//! The daemon's own interrupt of a run for an undo, carried by the one path a person's takes. Its
//! row is written and accepted at once, since an undo stops the run whatever version it reads,
//! and it takes no queue hold: the undo's own hold already holds every hand of the session, and
//! the waiting messages stay waiting for the undo's release to order. The undo awaits it, since
//! the undo cuts the conversation only once the run's turn has ended and answers the person with
//! what the interrupt came to. A hand the provider got with no answer back leaves its row
//! `accepted` for the run's end or the turn's end to settle, and a restart hands such a row
//! nothing.

use sidekicks_contracts::run::events::{DaemonInterventionActor, InterventionActor};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::{
    InterruptInterventionRecord, InterventionState, InterventionType, UndoInterruptRecord,
};
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_provider::driver::contract::error::DriverError;

use crate::interventions::interrupt_queue::InterruptCause;
use crate::interventions::limit_stop::mint_client_key;
use crate::interventions::service::errors::{DispatchError, InterventionError};
use crate::interventions::service::reached_state::{ReachedState, draft};
use crate::interventions::service::{
    InterventionService, InterventionTarget, RecordedFailure, RowMove, RunEndOfVerdict,
    mint_intervention_id,
};
use crate::interventions::store::{
    InterventionTransition, RequestedIntervention, insert_requested_intervention_statement,
    move_intervention_statement,
};
use crate::run::read::safe_run_version;

impl InterventionService {
    /// Interrupts `run_id` for the undo `undo_key`, the waiting messages left waiting, and answers
    /// once the run's turn has ended: its row, written `accepted` with the daemon as its actor,
    /// ends `applied` with the run ended `interrupted`, or with nothing left to cut. Refuses
    /// `agent.run.notFound` for an unknown run and fails as a write fails; any other end is
    /// [`InterventionError::TurnNotEnded`], degraded, failed with the dispatch's cause, expired, or
    /// `accepted` with the provider's answer outstanding for the run's end or the turn's end to
    /// settle, so the undo never cuts past a turn still open.
    pub async fn interrupt_for_undo(
        &self,
        run_id: RunId,
        undo_key: ClientUuid,
    ) -> Result<(), InterventionError> {
        let _hold = self.interrupt_lock.acquire(run_id).await;
        let run = self.require_run(run_id).await?;
        let target = InterventionTarget {
            session_id: run.session_id,
            intervention_id: mint_intervention_id(),
            target_run_id: run_id,
            intervention_type: InterventionType::Interrupt,
            actor: InterventionActor::Daemon(DaemonInterventionActor::Value),
        };
        let requested = RequestedIntervention {
            intervention_id: target.intervention_id,
            target_run_id: run_id,
            intervention_type: InterventionType::Interrupt,
            payload: serde_json::to_string(&InterruptInterventionRecord::Undo(
                UndoInterruptRecord { undo_key },
            ))
            .expect("an undo's interrupt record serializes"),
            expected_run_version: safe_run_version(run.version),
            client_idempotency_key: mint_client_key(),
            device_id: None,
        };
        let accepted_event = draft(&target, &ReachedState::Accepted)?;
        let requested_event = draft(&target, &ReachedState::Requested)?;
        self.engine
            .append(
                accepted_event,
                vec![
                    insert_requested_intervention_statement(&requested),
                    move_intervention_statement(
                        &target.intervention_id,
                        &InterventionTransition::Accept,
                    ),
                ],
                vec![requested_event],
                None,
            )
            .await?;
        let verdict = match self.interrupt_keeping_waiting(run_id, run.version).await {
            Ok(verdict) => verdict,
            Err(dispatch) => return self.fail_undo_hand(&target, dispatch).await,
        };
        let recorded = self
            .record_verdict(
                &target,
                verdict,
                Some(RunEndOfVerdict {
                    accepted_run_version: run.version,
                    cause: InterruptCause::Undo,
                }),
            )
            .await?;
        match recorded {
            RowMove::Made(ReachedState::Applied) => Ok(()),
            // Degraded, or settled first by the run's end or a turn's end.
            RowMove::Made(_) | RowMove::SettledSince => self.answer_undo_row(&target, None).await,
        }
    }

    // Records the dispatch's failure and answers it. A hand the provider got with no answer back
    // may still cut the turn, so its row stays `accepted` for the run's end or the turn's end to
    // settle, the run's end settling it here when it read the row too early.
    async fn fail_undo_hand(
        &self,
        target: &InterventionTarget,
        dispatch: DispatchError,
    ) -> Result<(), InterventionError> {
        if let DispatchError::Driver(DriverError::Unanswered(_)) = &dispatch {
            self.engine
                .settle_unresolved_of_ended_run(target.target_run_id)
                .await?;
            return self.answer_undo_row(target, Some(dispatch)).await;
        }
        match self.record_failure(target, dispatch).await? {
            RecordedFailure::Recorded { dispatch, .. } => Err(undo_failure(
                target,
                InterventionState::Failed,
                Some(dispatch),
            )),
            RecordedFailure::SettledSince { dispatch } => {
                self.answer_undo_row(target, Some(dispatch)).await
            }
        }
    }

    // The undo's answer from its row as it reads now: done once an end applied it, else the
    // failure that names the state it reached and what the dispatch threw, where it threw.
    async fn answer_undo_row(
        &self,
        target: &InterventionTarget,
        dispatch: Option<DispatchError>,
    ) -> Result<(), InterventionError> {
        match self.read_stored(target).await?.state {
            InterventionState::Applied => Ok(()),
            state @ (InterventionState::Requested
            | InterventionState::Accepted
            | InterventionState::Degraded
            | InterventionState::Expired
            | InterventionState::Rejected
            | InterventionState::Failed) => Err(undo_failure(target, state, dispatch)),
        }
    }
}

// What the undo is answered for an interrupt that did not end the run's turn, its row in `state`:
// a refusal, a missing driver and the engine's failure as they are, any other as the turn left
// open.
fn undo_failure(
    target: &InterventionTarget,
    state: InterventionState,
    dispatch: Option<DispatchError>,
) -> InterventionError {
    match dispatch {
        Some(DispatchError::Refused(refusal)) => InterventionError::Refused(refusal),
        Some(DispatchError::NoDriver(error)) => InterventionError::NoDriver(error),
        Some(DispatchError::Engine(error)) => InterventionError::Engine(error),
        dispatch @ (None
        | Some(
            DispatchError::Driver(_)
            | DispatchError::Queue(_)
            | DispatchError::RejectionReason(_)
            | DispatchError::RunContinued,
        )) => InterventionError::TurnNotEnded {
            intervention_id: target.intervention_id,
            state,
            dispatch: dispatch.map(Box::new),
        },
    }
}

#[cfg(test)]
mod tests;
