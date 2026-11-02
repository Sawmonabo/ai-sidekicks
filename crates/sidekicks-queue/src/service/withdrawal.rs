//! The withdrawal of the message the daemon sent for a plan, when what it carried out has ended:
//! a hand-off's seed, taken back from a fresh session that was archived, closed or purged before a
//! run took it, so no run opens with it and no retry sends it again.

use sidekicks_contracts::plan::PlanId;
use sidekicks_contracts::run::queue::PlanMessageKind;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_session::queue_store::{QueueItemReader, QueueItemRecord, RecordedQueueItemState};
use sidekicks_std::keyed_lock::KeyHold;
use sidekicks_store::database::connection::read_pool::ReadLength;

use super::RunQueue;
use crate::delivery::QueueWithdrawal;
use crate::error::QueueError;

/// What the withdrawal of a plan message found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanMessageWithdrawal {
    /// It reads canceled: withdrawn now, or by an earlier withdrawal.
    Canceled,
    /// A run took it, or is starting with it: it stays, and what it carries out goes on.
    Taken,
}

impl RunQueue {
    /// Withdraws the session's plan message of `kind` for `plan_id`, found by the plan it carries
    /// whatever key a retry sent it again under: a waiting one is taken back from delivery and one
    /// read not delivered is canceled outright, either reading canceled; one a run took or is
    /// starting with is answered as taken, nothing written. Answers `None` when the session holds
    /// no such message; fails as a read or a write fails.
    pub async fn withdraw_plan_message(
        &self,
        session_id: SessionId,
        plan_id: PlanId,
        kind: PlanMessageKind,
    ) -> Result<Option<PlanMessageWithdrawal>, QueueError> {
        let hold = self.session_lock.hold_session(session_id).await;
        let found = self
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, QueueError>(QueueItemReader::new(reader).get_plan_message(
                    &session_id,
                    &plan_id,
                    kind,
                )?)
            })
            .await?;
        let Some(item) = found else {
            return Ok(None);
        };
        let withdrawal = match item.state {
            RecordedQueueItemState::Queued => self.withdraw_queued(&hold, item).await?,
            RecordedQueueItemState::NotDelivered { .. } => self.cancel_undelivered(&item).await?,
            RecordedQueueItemState::Admitted => PlanMessageWithdrawal::Taken,
            RecordedQueueItemState::Canceled => PlanMessageWithdrawal::Canceled,
            RecordedQueueItemState::Superseded => {
                unreachable!("the read passes over an item a retry superseded")
            }
        };
        Ok(Some(withdrawal))
    }

    // Takes the waiting `item` back from delivery and cancels it once given back, as a person's
    // removal does. No hand takes a plan message, so its provider never holds one: one not given
    // back is a starting run's opening, which stays.
    async fn withdraw_queued(
        &self,
        hold: &KeyHold<'_, SessionId>,
        item: QueueItemRecord,
    ) -> Result<PlanMessageWithdrawal, QueueError> {
        let withdrawals = self
            .delivery
            .take_back(hold, std::slice::from_ref(&item))
            .await?;
        if withdrawals.get(&item.id) != Some(&QueueWithdrawal::Returned) {
            return Ok(PlanMessageWithdrawal::Taken);
        }
        self.settle_canceled(hold, item).await?;
        Ok(PlanMessageWithdrawal::Canceled)
    }

    // Cancels `item`, read not delivered, so no retry sends it again. Its hand is kept, so a
    // provider's late answer for it still settles; a late admission that lands first answers it
    // taken.
    async fn cancel_undelivered(
        &self,
        item: &QueueItemRecord,
    ) -> Result<PlanMessageWithdrawal, QueueError> {
        let Err(error) = self
            .recorder
            .record_undelivered_cancel(item, &WireInstant::now())
            .await
        else {
            return Ok(PlanMessageWithdrawal::Canceled);
        };
        if !error.is_refused() {
            return Err(error.into());
        }
        match self.read_item(item.id).await?.map(|current| current.state) {
            Some(RecordedQueueItemState::Admitted) => Ok(PlanMessageWithdrawal::Taken),
            Some(RecordedQueueItemState::Canceled) => Ok(PlanMessageWithdrawal::Canceled),
            Some(
                RecordedQueueItemState::Queued
                | RecordedQueueItemState::NotDelivered { .. }
                | RecordedQueueItemState::Superseded,
            )
            | None => Err(error.into()),
        }
    }
}
