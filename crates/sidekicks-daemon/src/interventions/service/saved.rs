//! The answers the service reads back from a stored row: a reused key's saved result, or its
//! conflict, and the outcome a row reached where another write settled it first.

use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::{
    AgentRunInterveneRequest, AgentRunInterveneResponse, InterventionId, InterventionState,
};
use sidekicks_contracts::wire::id::ClientUuid;

use super::errors::InterventionError;
use super::reached_state::{ReachedState, response};
use super::request::intervention_type_of;
use super::{InterventionService, InterventionTarget, RowMove};
use crate::database::connection::read_pool::ReadLength;
use crate::interventions::store::{
    SavedIntervention, read_intervention, read_intervention_by_idempotency_key,
};
use crate::ipc::domain_error::DomainError;
use crate::session::run::engine::RunEngineError;
use crate::settle_all::{SettleFailures, settle_all};

impl InterventionService {
    /// The intervention saved on `run_id` under `key`, if one is. Fails as the read fails.
    pub(super) async fn read_saved_intervention(
        &self,
        run_id: RunId,
        key: &ClientUuid,
    ) -> Result<Option<SavedIntervention>, InterventionError> {
        let key = key.clone();
        Ok(self
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, RunEngineError>(read_intervention_by_idempotency_key(
                    reader, &run_id, &key,
                )?)
            })
            .await?)
    }

    /// A reused key answers what the first request saved when the two ask for the same thing, and
    /// refuses with a conflict otherwise. Fails as the run's read fails.
    pub(super) async fn answer_saved(
        &self,
        request: &AgentRunInterveneRequest,
        run_id: RunId,
        saved: SavedIntervention,
        payload: &str,
    ) -> Result<AgentRunInterveneResponse, InterventionError> {
        if saved.intervention_type != intervention_type_of(request) || saved.payload != payload {
            return Err(idempotency_conflict(run_id, saved.intervention_id));
        }
        let run = self.require_run(run_id).await?;
        Ok(response(
            saved.intervention_id,
            saved.intervention_type,
            &run,
            &reached_state_of(saved)?,
        ))
    }

    /// The answer for the target's row as it is stored now. Fails as the reads fail.
    pub(super) async fn answer_stored(
        &self,
        target: &InterventionTarget,
    ) -> Result<AgentRunInterveneResponse, InterventionError> {
        let saved = self.read_stored(target).await?;
        self.answer(target, &reached_state_of(saved)?).await
    }

    /// The target's row as it is stored now. Fails as the read fails, or with
    /// [`InterventionError::Unread`] for a row the daemon has none of.
    pub(in crate::interventions) async fn read_stored(
        &self,
        target: &InterventionTarget,
    ) -> Result<SavedIntervention, InterventionError> {
        let intervention_id = target.intervention_id;
        self.pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, RunEngineError>(read_intervention(reader, &intervention_id)?)
            })
            .await?
            // An intervention row is never deleted.
            .ok_or(InterventionError::Unread {
                intervention_id: target.intervention_id,
            })
    }

    /// Whether the target's row, whose own move a guard refused, reached an outcome another write
    /// gave it since it was read, its run's end or a turn's end; a row still pending was moved
    /// some other way. Fails as the read fails.
    pub(super) async fn is_settled_since(
        &self,
        target: &InterventionTarget,
    ) -> Result<bool, InterventionError> {
        Ok(!matches!(
            self.read_stored(target).await?.state,
            InterventionState::Requested | InterventionState::Accepted
        ))
    }

    /// No move where the target's row, whose move failed with `refused` on its guard, reached an
    /// outcome another write gave it since it was read. Fails with `refused` for a row still
    /// pending, and with the read's failure beside it when the row cannot be read.
    pub(super) async fn settled_since_or<Moved>(
        &self,
        target: &InterventionTarget,
        refused: InterventionError,
    ) -> Result<RowMove<Moved>, InterventionError> {
        match self.is_settled_since(target).await {
            Ok(true) => Ok(RowMove::SettledSince),
            Ok(false) => Err(refused),
            Err(read) => Err(with_failed_read(refused, read)),
        }
    }

    /// The answer for `state`, with the run's version as it is now. Fails as the run's read fails.
    pub(super) async fn answer(
        &self,
        target: &InterventionTarget,
        state: &ReachedState,
    ) -> Result<AgentRunInterveneResponse, InterventionError> {
        let run = self.require_run(target.target_run_id).await?;
        Ok(response(
            target.intervention_id,
            target.intervention_type,
            &run,
            state,
        ))
    }
}

// What a saved row reached, its reason read with it. Fails with
// [`InterventionError::Unreasoned`] for a rejected or failed row stored with no reason.
fn reached_state_of(saved: SavedIntervention) -> Result<ReachedState, InterventionError> {
    let reason_missing = || InterventionError::Unreasoned {
        intervention_id: saved.intervention_id,
        state: saved.state,
    };
    Ok(match saved.state {
        InterventionState::Requested => ReachedState::Requested,
        InterventionState::Accepted => ReachedState::Accepted,
        InterventionState::Applied => ReachedState::Applied,
        InterventionState::Degraded => ReachedState::Degraded,
        InterventionState::Expired => ReachedState::Expired,
        InterventionState::Rejected => {
            ReachedState::Rejected(saved.rejection_reason.ok_or_else(reason_missing)?)
        }
        InterventionState::Failed => {
            ReachedState::Failed(saved.failure_reason.ok_or_else(reason_missing)?)
        }
    })
}

/// The refusal of a request that reuses the key of `run_id`'s intervention `saved` and asks for
/// something else.
pub(super) fn idempotency_conflict(run_id: RunId, saved: InterventionId) -> InterventionError {
    InterventionError::Refused(
        DomainError::new(
            "The idempotency key was already used for a different intervention on this run",
            RefusalCode::AgentInterventionIdempotencyConflict,
        )
        .with_detail(json!({ "targetRunId": run_id, "interventionId": saved })),
    )
}

/// `refused` with the failed read of whether its row settled since beside it, both kept.
pub(super) fn with_failed_read(
    refused: InterventionError,
    read: InterventionError,
) -> InterventionError {
    let failures = settle_all(
        (Err::<(), _>(refused), Err::<(), _>(read)),
        "moving an intervention's row and reading it back",
    )
    .expect_err("both failures are kept");
    match failures {
        SettleFailures::One(failure) => failure,
        many @ SettleFailures::Many { .. } => InterventionError::Several(Box::new(many)),
    }
}
