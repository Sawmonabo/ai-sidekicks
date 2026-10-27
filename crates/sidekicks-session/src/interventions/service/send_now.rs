//! `Send now` on a provider that reads a priority message: an interrupt whose choice puts a
//! waiting message first in the next turn hands that message ahead of what the provider holds
//! instead, and records no intervention row. The run keeps the request's key with the message and
//! the id the first answer carried, so a request sent again under it runs again while the message
//! waits with that mark in force, answers what the first did once the message left the queue or a
//! later order took its mark, and one that asks for something else under it is refused as a
//! conflict.

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::{
    AgentRunInterveneRequest, AgentRunInterveneResponse, InterventionInterruptRequest,
    InterventionType,
};
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_provider::driver::run_control::InterruptPendingChoice;
use sidekicks_store::database::connection::read_pool::ReadLength;

use super::errors::InterventionError;
use super::reached_state::{ReachedState, response};
use super::request::{interrupt_choice_of, interrupt_keys};
use super::saved::idempotency_conflict;
use super::{InterventionService, InterventionTarget};
use crate::driver_resolution::{LiveRunDriverError, read_run_driver};
use crate::interventions::interrupt_queue::{SendNow, SendNowOutcome};
use crate::queue_store::send_now::read_sent_now;
use crate::queue_store::{QueueItemReader, RecordedQueueItemState};
use crate::run::engine::RunEngineError;
use crate::run::read::RunRead;

impl InterventionService {
    /// What a `Send now` saved under `key` on `run_id` answers `request`: the first's `applied`
    /// once its message left the queue, taken, removed, replaced or never delivered, or no longer
    /// carries the mark the key's `Send now` put on it, when `request` puts that message first in
    /// the next turn; a conflict when it asks for anything else; and `None` where no `Send now`
    /// spent the key, or its message still waits with that mark, so the request runs again. Fails
    /// as the read fails.
    pub(super) async fn answer_sent_now(
        &self,
        request: &AgentRunInterveneRequest,
        run_id: RunId,
        run: &RunRead,
        key: &ClientUuid,
    ) -> Result<Option<AgentRunInterveneResponse>, InterventionError> {
        let key = key.clone();
        let sent = self
            .pool
            .read(ReadLength::Short, move |reader| {
                let Some(sent) = read_sent_now(reader, &run_id, &key)? else {
                    return Ok::<_, RunEngineError>(None);
                };
                let item = QueueItemReader::new(reader).get(&sent.item_id)?;
                Ok(Some((sent, item)))
            })
            .await?;
        let Some((sent, item)) = sent else {
            return Ok(None);
        };
        let is_same_request = match request {
            AgentRunInterveneRequest::Interrupt(interrupt) => {
                let choice = interrupt_choice_of(interrupt);
                choice.pending == InterruptPendingChoice::NextTurn
                    && choice.deliver_first == Some(sent.item_id)
            }
            AgentRunInterveneRequest::FasterModelRetry { .. } => false,
        };
        if !is_same_request {
            return Err(idempotency_conflict(run_id, sent.intervention_id));
        }
        // A mark in force is the key's `Send now` not yet done, its hand failed or never made; a
        // mark a later order cleared, or another `Send now` put on, leaves the key's done.
        if item.is_some_and(|item| {
            item.state == RecordedQueueItemState::Queued
                && item.sent_now_id == Some(sent.intervention_id)
        }) {
            return Ok(None);
        }
        Ok(Some(response(
            sent.intervention_id,
            InterventionType::Interrupt,
            run,
            &ReachedState::Applied,
        )))
    }

    /// Hands the message `interrupt` puts first in the next turn ahead of what the run's provider
    /// holds, where the provider reads a priority message; `None` leaves the request to the
    /// interrupt, as does a provider no driver answers, whose interrupt then records why. Refuses
    /// as the queue refuses the message, and fails as the driver's read or the queue fails.
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
        let reads_priority_message =
            match read_run_driver::<InterventionError>(&self.pool, &self.providers, run_id).await {
                Ok(driver) => driver.message_handing().reads_priority_message,
                Err(InterventionError::NoDriver(LiveRunDriverError::ProviderNotFound(_))) => false,
                Err(error) => return Err(error),
            };
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
        let (answered, state) = match outcome {
            SendNowOutcome::Sent { intervention_id } => (
                InterventionTarget {
                    intervention_id,
                    ..target.clone()
                },
                ReachedState::Applied,
            ),
            SendNowOutcome::Expired => (target.clone(), ReachedState::Expired),
            SendNowOutcome::Refused(refusal) => return Err(InterventionError::Refused(refusal)),
        };
        Ok(Some(self.answer(&answered, &state).await?))
    }
}
