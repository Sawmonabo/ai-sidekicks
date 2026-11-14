//! The continue of an interrupted run: its place at the gate again, its opening taken under the
//! session's lock, and what a continue that failed leaves for the run's messages. A review or a
//! plan message is never a continue's opening: one left waiting for the run with no message beside
//! it goes on to a next run of its own.

use std::sync::Arc;

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{QueueItemNotDeliveredReason, read_message_words};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_provider::driver::contract::ProviderDriver;
use sidekicks_session::queue_store::{QueueItemReader, QueueItemRecord};
use sidekicks_session::run::agent::read_lead_agent_through;
use sidekicks_session::run::engine::errors::RunEngineError;
use sidekicks_session::run::read::read_run_through;
use sidekicks_session::run::start_request::RunContinueRequest;
use sidekicks_std::keyed_lock::KeyHold;
use sidekicks_store::database::connection::read_pool::ReadLength;

use super::{Placed, QueueAdmission, is_invalid_transition, is_waiting, log_failure};
use crate::delivery::run_end::FAILED_DELIVERY_REASON;
use crate::error::QueueError;
use crate::recorder::lead_run_queued;

impl QueueAdmission {
    pub(super) async fn continue_interrupted(
        self: &Arc<Self>,
        session_id: SessionId,
        run_id: RunId,
    ) -> Result<(), QueueError> {
        let pending = self.pending_reservation(run_id);
        let (provider, provider_account_id, driver) =
            self.read_run_driver(session_id, run_id).await?;
        if !self
            .admit_continue(
                &provider,
                provider_account_id.clone(),
                driver.as_ref(),
                session_id,
                run_id,
            )
            .await?
        {
            return Ok(());
        }
        let execution_posture = self
            .deps
            .provider_sessions
            .read_execution_posture(session_id, provider_account_id.clone())
            .await?;
        // Taken under the lock, so a removal either lands first or finds the opening taken.
        let (opening, own_run_id) = {
            let hold = self.hold_session_for_opening(session_id).await;
            let is_interrupted = read_run_through::<QueueError>(&self.deps.pool, run_id)
                .await?
                .is_some_and(|run| run.state == RunState::Interrupted);
            let lead_waiting: Vec<QueueItemRecord> = if is_interrupted {
                self.read_waiting(run_id)
                    .await?
                    .into_iter()
                    .filter(|item| item.child_handle.is_none())
                    .collect()
            } else {
                Vec::new()
            };
            let (messages, own_run_items): (Vec<_>, Vec<_>) = lead_waiting
                .into_iter()
                .partition(|item| item.body.as_message().is_some());
            let head = self.take_opening(pending, &messages);
            let own_run_id = if head.is_none() && !own_run_items.is_empty() {
                Some(
                    self.queue_own_run_items(&hold, &own_run_items, provider_account_id)
                        .await?,
                )
            } else {
                None
            };
            (head, own_run_id)
        };
        let Some(opening) = opening else {
            // Nothing is left to continue the run with, so it rests holding no place.
            self.release(run_id);
            if let Some(own_run_id) = own_run_id {
                self.start(session_id, own_run_id);
            }
            return Ok(());
        };
        let continued = self
            .deps
            .engine
            .continue_run(RunContinueRequest {
                turn: self.turn_start(
                    session_id,
                    run_id,
                    &driver,
                    &opening,
                    execution_posture,
                    true,
                ),
                opening_words: read_message_words(
                    &opening
                        .body
                        .as_message()
                        .expect("a continue opens only on a message")
                        .content,
                ),
            })
            .await;
        if let Err(continue_error) = continued {
            // A run its provider is continuing is handed the opening with the rest once it runs.
            self.deps.openings.remove(run_id);
            let is_interrupted = read_run_through::<QueueError>(&self.deps.pool, run_id)
                .await?
                .is_some_and(|run| run.state == RunState::Interrupted);
            let error = QueueError::from(continue_error);
            if is_invalid_transition(&error) || !is_taken_over(&error) && !is_interrupted {
                return Err(error);
            }
            let current = self.read_item(&opening).await?;
            // A run that took over the messages, even while the driver held the continue back,
            // takes the opening with them.
            if current
                .as_ref()
                .is_some_and(|current| current.target_run_id != Some(run_id))
            {
                return Err(QueueError::ContinueTakenOver { run_id });
            }
            if current.as_ref().is_some_and(is_waiting) {
                self.record_not_delivered(&opening, FAILED_DELIVERY_REASON)
                    .await?;
            }
            return Err(error);
        }
        self.record_admitted(&opening, run_id).await?;
        self.deps.openings.remove(run_id);
        Ok(())
    }

    // What a continue that failed leaves: a run its provider continues, or one that ended another
    // way, keeps its messages; one a newer lead run took over hands that run its messages; any
    // other leaves those still waiting for it not delivered.
    pub(super) async fn settle_failed_continue(
        &self,
        session_id: SessionId,
        run_id: RunId,
        error: QueueError,
    ) {
        if is_invalid_transition(&error) {
            return;
        }
        if matches!(error, QueueError::ContinueTakenOver { .. }) {
            self.release(run_id);
            if let Err(hand) = self.hand_taken_over(session_id, run_id).await {
                log_failure(
                    session_id,
                    run_id,
                    &hand,
                    "handing a continue's messages to the run that took them over failed",
                );
            }
            return;
        }
        let is_interrupted = match read_run_through::<QueueError>(&self.deps.pool, run_id).await {
            Ok(run) => run.is_some_and(|run| run.state == RunState::Interrupted),
            Err(read) => {
                log_failure(
                    session_id,
                    run_id,
                    &read,
                    "reading a run after its failed continue",
                );
                false
            }
        };
        if !is_interrupted {
            return;
        }
        log_failure(
            session_id,
            run_id,
            &error,
            "continuing an interrupted run failed",
        );
        self.release(run_id);
        let hold = self.deps.session_lock.hold_session(session_id).await;
        let marked = self
            .mark_waiting_undelivered(&hold, run_id, FAILED_DELIVERY_REASON)
            .await;
        if let Err(mark) = marked {
            log_failure(
                session_id,
                run_id,
                &mark,
                "settling the messages of a run after its failed continue failed",
            );
        }
    }

    // Queues the session's next lead run for `own_run_items`, the reviews and plan messages left
    // waiting for its interrupted lead run, which open a run of their own, pointing each at it, on
    // `provider_account_id`'s account, the one the interrupted run ran on, and answers its id.
    // Called under `hold`; fails as the read or the write fails.
    async fn queue_own_run_items(
        &self,
        hold: &KeyHold<'_, SessionId>,
        own_run_items: &[QueueItemRecord],
        provider_account_id: ProviderAccountId,
    ) -> Result<RunId, QueueError> {
        let session_id = *hold.key();
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        let agent_id = read_lead_agent_through::<QueueError>(&self.deps.pool, session_id).await?;
        let run_config = self.lead_run_config(session_id).await?;
        self.deps
            .recorder
            .record_next_run(
                lead_run_queued(
                    session_id,
                    run_id,
                    agent_id,
                    provider_account_id,
                    run_config,
                ),
                own_run_items,
                &WireInstant::now(),
            )
            .await?;
        Ok(run_id)
    }

    // The lead messages a newer lead run took over from the given-up continue of `run_id` go to
    // that run now that the continue's opening is no longer one.
    async fn hand_taken_over(
        &self,
        session_id: SessionId,
        run_id: RunId,
    ) -> Result<(), QueueError> {
        let hold = self.deps.session_lock.hold_session(session_id).await;
        let current_run_id = self
            .deps
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, QueueError>(QueueItemReader::new(reader).read_live_lead_run(&session_id)?)
            })
            .await?;
        if let Some(current_run_id) = current_run_id.filter(|current| *current != run_id) {
            self.deps
                .delivery
                .hand_waiting(&hold, current_run_id)
                .await?;
        }
        Ok(())
    }

    // Takes the continued run's place at the gate: its parked place again, the run going on while
    // it waits, or a new place it waits for as a start does. Answers `false` when that wait
    // outlived the delivery timeout, its messages then not delivered, or the place was released
    // meanwhile.
    async fn admit_continue(
        &self,
        provider: &ProviderId,
        provider_account_id: ProviderAccountId,
        driver: &dyn ProviderDriver,
        session_id: SessionId,
        run_id: RunId,
    ) -> Result<bool, QueueError> {
        if self.lock().places.contains_key(&run_id) {
            self.resume(run_id);
            return Ok(true);
        }
        match self
            .take_place(provider, provider_account_id, driver, session_id, run_id)
            .await?
        {
            Placed::Admitted => Ok(true),
            Placed::Released => Ok(false),
            Placed::TimedOut => {
                let hold = self.deps.session_lock.hold_session(session_id).await;
                self.mark_waiting_undelivered(
                    &hold,
                    run_id,
                    QueueItemNotDeliveredReason::TimedOut {},
                )
                .await?;
                Ok(false)
            }
        }
    }
}

// Whether a continue's driver start found its opening taken over by a newer lead run.
fn is_taken_over(error: &QueueError) -> bool {
    matches!(
        error,
        QueueError::Engine(RunEngineError::Driver { source, .. })
            if source
                .downcast_ref::<QueueError>()
                .is_some_and(|source| matches!(source, QueueError::ContinueTakenOver { .. }))
    )
}
