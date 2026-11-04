//! The withdrawal of the message the daemon sent for a plan, when what it carried out has ended:
//! a hand-off's seed, taken back from a fresh session that was archived, closed or purged before a
//! run took it, so no run opens with it and no retry sends it again; and what a cancel of a queue
//! item found, which a person's removal shares.

use sidekicks_contracts::plan::PlanId;
use sidekicks_contracts::run::queue::PlanMessageKind;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_session::queue_store::{QueueItemReader, QueueItemRecord, RecordedQueueItemState};
use sidekicks_std::keyed_lock::KeyHold;
use sidekicks_store::database::connection::read_pool::ReadLength;

use super::RunQueue;
use crate::delivery::QueueWithdrawal;
use crate::error::QueueError;

/// What a cancel of a queue item found: a plan message's withdrawal, or a person's removal of an
/// item that reads not delivered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CancelOutcome {
    /// It reads canceled: canceled now, or by an earlier cancel.
    Canceled,
    /// A run took it, or is starting with it: it stays.
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
    ) -> Result<Option<CancelOutcome>, QueueError> {
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
            RecordedQueueItemState::Admitted => CancelOutcome::Taken,
            RecordedQueueItemState::Canceled => CancelOutcome::Canceled,
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
    ) -> Result<CancelOutcome, QueueError> {
        let withdrawals = self
            .delivery
            .take_back(hold, std::slice::from_ref(&item))
            .await?;
        if withdrawals.get(&item.id) != Some(&QueueWithdrawal::Returned) {
            return Ok(CancelOutcome::Taken);
        }
        self.settle_canceled(hold, item).await?;
        Ok(CancelOutcome::Canceled)
    }
}
