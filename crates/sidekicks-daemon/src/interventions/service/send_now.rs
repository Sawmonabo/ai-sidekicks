//! `Send now` on a provider that reads a priority message: an interrupt whose choice puts a
//! waiting message first in the next turn hands that message ahead of what the provider holds
//! instead, and records no intervention row. The message carries the request's key, so a request
//! sent again under it answers what the first did, and one that asks for something else under it
//! is refused as a conflict.

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::{
    AgentRunInterveneResponse, InterventionInterruptRequest, InterventionType,
};
use sidekicks_contracts::wire::id::ClientUuid;

use super::errors::{DispatchError, InterventionError};
use super::reached_state::{ReachedState, response};
use super::request::{interrupt_choice_of, interrupt_keys};
use super::saved::idempotency_conflict;
use super::{InterventionService, InterventionTarget};
use crate::database::connection::read_pool::ReadLength;
use crate::interventions::interrupt_queue::{SendNow, SendNowOutcome};
use crate::ipc::handlers::driver::resolution::read_run_driver;
use crate::provider::driver::run_control::InterruptPendingChoice;
use crate::queue::store::send_now::read_sent_now;
use crate::session::run::engine::RunEngineError;
use crate::session::run::read::RunRead;

impl InterventionService {
    /// What a `Send now` saved under `key` on the session of `run` answers `interrupt`: the
    /// message it handed when `interrupt` puts that message first in the next turn, a conflict
    /// when it asks for anything else, and `None` where no `Send now` spent the key. Fails as the
    /// read fails.
    pub(super) async fn answer_sent_now(
        &self,
        interrupt: &InterventionInterruptRequest,
        run_id: RunId,
        run: &RunRead,
        key: &ClientUuid,
    ) -> Result<Option<AgentRunInterveneResponse>, InterventionError> {
        let session_id = run.session_id;
        let key = key.clone();
        let sent = self
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, RunEngineError>(read_sent_now(reader, &session_id, &key)?)
            })
            .await?;
        let Some(sent) = sent else {
            return Ok(None);
        };
        let choice = interrupt_choice_of(interrupt);
        if choice.pending != InterruptPendingChoice::NextTurn
            || choice.deliver_first != Some(sent.item_id)
        {
            return Err(idempotency_conflict(run_id, sent.intervention_id));
        }
        Ok(Some(response(
            sent.intervention_id,
            InterventionType::Interrupt,
            run,
            &ReachedState::Applied,
        )))
    }

    /// Hands the message `interrupt` puts first in the next turn ahead of what the run's provider
    /// holds, where the provider reads a priority message and the run takes messages now; `None`
    /// leaves the request to the interrupt. Refuses as the queue refuses the message, and fails as
    /// the queue fails.
    pub(super) async fn send_now(
        &self,
        interrupt: &InterventionInterruptRequest,
        target: &InterventionTarget,
    ) -> Result<Option<AgentRunInterveneResponse>, InterventionError> {
        let choice = interrupt_choice_of(interrupt);
        let Some(item_id) = choice.deliver_first else {
            return Ok(None);
        };
        if choice.pending != InterruptPendingChoice::NextTurn {
            return Ok(None);
        }
        let run_id = target.target_run_id;
        // A driver that cannot be found fails the interrupt's own dispatch, which records why.
        let reads_priority_message =
            read_run_driver::<DispatchError>(&self.pool, &self.providers, run_id)
                .await
                .is_ok_and(|driver| driver.message_handing().reads_priority_message);
        if !reads_priority_message {
            return Ok(None);
        }
        let (_, expected_run_version, key) = interrupt_keys(interrupt);
        let outcome = self
            .queue
            .send_now(SendNow {
                run_id,
                expected_run_version,
                item_id,
                key: key.clone(),
                intervention_id: target.intervention_id,
            })
            .await
            .map_err(InterventionError::Queue)?;
        let state = match outcome {
            SendNowOutcome::Sent => ReachedState::Applied,
            SendNowOutcome::Expired => ReachedState::Expired,
            SendNowOutcome::Refused(refusal) => return Err(InterventionError::Refused(refusal)),
            SendNowOutcome::Interrupt => return Ok(None),
        };
        Ok(Some(self.answer(target, &state).await?))
    }
}
