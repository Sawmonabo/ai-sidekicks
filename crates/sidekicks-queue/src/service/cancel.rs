//! A person's removal of a waiting message, or of a lead item that reads not delivered, and the
//! settle every cancel of a waiting message shares: a queued run left with no message to start
//! with ends `stopped` in the same write.

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{
    AgentQueueItemCancelRequest, AgentQueueItemCancelResponse, AgentQueueItemCanceledState,
    AgentQueueItemChangeRefusedReason, PlanMessageKind, QueueItemId,
};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_session::queue_store::{
    QueueItemBody, QueueItemOutcome, QueueItemRecord, RecordedQueueItemState,
};
use sidekicks_session::run::read::read_run_through;
use sidekicks_std::keyed_lock::KeyHold;

use super::RunQueue;
use super::withdrawal::CancelOutcome;
use crate::delivery::QueueWithdrawal;
use crate::error::QueueError;
use crate::refusals::{
    UnreturnedReason, change_refused, left_queue_refusal, queue_item_not_found, unreturned_refusal,
};

impl RunQueue {
    /// Removes a waiting message or a lead item that reads not delivered, so nothing reaches the
    /// agent, ending a queued run left with no message `stopped` in the same write. Refuses an
    /// item the queue does not hold, one the agent has taken, one its provider did not give back,
    /// a helper's message that reads not delivered, and a hand-off's seed (`handOffSeed`).
    pub async fn cancel(
        &self,
        request: AgentQueueItemCancelRequest,
    ) -> Result<AgentQueueItemCancelResponse, QueueError> {
        let item_id = request.queue_item_id;
        let found = self
            .read_item(item_id)
            .await?
            .filter(|found| found.child_handle == request.child_handle)
            .ok_or_else(|| queue_item_not_found(item_id))?;
        let session_id = found.session_id;
        let hold = self.session_lock.hold_session(session_id).await;
        // A purge of the session while the removal waited took its rows.
        let item = self
            .read_item(item_id)
            .await?
            .ok_or_else(|| queue_item_not_found(item_id))?;
        // A plan's build message is the person's to remove as any of theirs; a hand-off's seed is
        // the daemon's, which the fresh session's archive withdraws, whatever it reads.
        if let QueueItemBody::PlanMessage { plan_message, .. } = &item.body {
            match plan_message.kind {
                PlanMessageKind::Build => {}
                PlanMessageKind::Seed => {
                    return Err(change_refused(
                        AgentQueueItemChangeRefusedReason::HandOffSeed,
                        &format!(
                            "Queue item {} is the first message of a hand-off's fresh session, \
                             which only ending the hand-off cancels",
                            item.id
                        ),
                    )
                    .into());
                }
            }
        }
        let canceled = AgentQueueItemCancelResponse {
            queue_item_id: item_id,
            state: AgentQueueItemCanceledState::Value,
        };
        match item.state {
            RecordedQueueItemState::Queued => {}
            // A lead item read not delivered is canceled with its hand kept.
            RecordedQueueItemState::NotDelivered { .. } if item.child_handle.is_none() => {
                return match self.cancel_undelivered(&item).await? {
                    CancelOutcome::Canceled => Ok(canceled),
                    CancelOutcome::Taken => {
                        Err(unreturned_refusal(item.id, UnreturnedReason::Taken).into())
                    }
                };
            }
            RecordedQueueItemState::NotDelivered { .. }
            | RecordedQueueItemState::Admitted
            | RecordedQueueItemState::Superseded
            | RecordedQueueItemState::Canceled => return Err(left_queue_refusal(&item).into()),
        }
        let withdrawal = self
            .delivery
            .take_back(&hold, std::slice::from_ref(&item))
            .await?
            .get(&item.id)
            .copied()
            .unwrap_or(QueueWithdrawal::Unreturned(UnreturnedReason::Taken));
        if let QueueWithdrawal::Unreturned(reason) = withdrawal {
            return Err(unreturned_refusal(item.id, reason).into());
        }
        self.settle_canceled(&hold, item).await?;
        Ok(canceled)
    }

    // Settles `item`, waiting and given back by its provider, canceled: removing the last message
    // of a run that has not started ends that run `stopped` in the same write, and a lead message
    // no longer holds back its interrupted run's continue. Called under `hold`.
    pub(super) async fn settle_canceled(
        &self,
        hold: &KeyHold<'_, SessionId>,
        item: QueueItemRecord,
    ) -> Result<(), QueueError> {
        let run_id = item.target_run_id;
        let is_last_of_queued_run = match run_id {
            Some(run_id) => self.is_queued_run_emptied_by(run_id, &[item.id]).await?,
            None => false,
        };
        match run_id {
            Some(run_id) if is_last_of_queued_run => {
                self.admission
                    .stop_emptied_run(
                        hold,
                        run_id,
                        vec![(item, QueueItemOutcome::Canceled)],
                        Vec::new(),
                    )
                    .await?;
            }
            _ => {
                let is_lead = item.child_handle.is_none();
                self.recorder
                    .record_outcome(&item, QueueItemOutcome::Canceled, &WireInstant::now())
                    .await?;
                self.delivery.forget(&[item.id]);
                // A message the provider kept no longer holds back the interrupted run's continue.
                if let Some(run_id) = run_id.filter(|_| is_lead) {
                    self.lifecycle
                        .continue_interrupted_run(hold, run_id, false)
                        .await?;
                }
            }
        }
        Ok(())
    }

    // Cancels `item`, read not delivered, so no retry sends it again. Its hand is kept, so a
    // provider's late answer for it still settles; a late admission that lands first answers it
    // taken. Fails as the write fails, or when a refused write re-reads as neither.
    pub(super) async fn cancel_undelivered(
        &self,
        item: &QueueItemRecord,
    ) -> Result<CancelOutcome, QueueError> {
        let Err(error) = self
            .recorder
            .record_undelivered_cancel(item, &WireInstant::now())
            .await
        else {
            return Ok(CancelOutcome::Canceled);
        };
        if !error.is_refused() {
            return Err(error.into());
        }
        match self.read_item(item.id).await?.map(|current| current.state) {
            Some(RecordedQueueItemState::Admitted) => Ok(CancelOutcome::Taken),
            Some(RecordedQueueItemState::Canceled) => Ok(CancelOutcome::Canceled),
            Some(
                RecordedQueueItemState::Queued
                | RecordedQueueItemState::NotDelivered { .. }
                | RecordedQueueItemState::Superseded,
            )
            | None => Err(error.into()),
        }
    }

    // Whether removing `removed` leaves the queued run `run_id` with no message to start with.
    pub(super) async fn is_queued_run_emptied_by(
        &self,
        run_id: RunId,
        removed: &[QueueItemId],
    ) -> Result<bool, QueueError> {
        let is_queued = read_run_through::<QueueError>(&self.pool, run_id)
            .await?
            .is_some_and(|run| run.state == RunState::Queued);
        if !is_queued {
            return Ok(false);
        }
        let waiting = self.read_waiting(run_id).await?;
        Ok(waiting.iter().all(|item| removed.contains(&item.id)))
    }
}
