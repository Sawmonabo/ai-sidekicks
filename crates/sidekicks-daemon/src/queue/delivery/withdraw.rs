//! The take-back ahead of a change: each handed message is withdrawn from its provider on the
//! session's chain within [`WITHDRAW_DEADLINE`], one not handed is the queue's at once, and a
//! withdraw the provider answers past the deadline is settled on the chain when it comes.

use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use futures::future::join_all;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::id::SessionId;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use tracing::Instrument as _;

use crate::bounded_wait::wait_within;
use crate::database::connection::read_pool::ReadLength;
use crate::ipc::handlers::driver::resolution::read_run_driver;
use crate::keyed_lock::KeyHold;
use crate::provider::driver::run_control::{
    WithdrawQueuedMessageParams, WithdrawQueuedMessageResult,
};
use crate::queue::delivery::chain::ChainJob;
use crate::queue::delivery::state::HandRoute;
use crate::queue::delivery::{DeliveryError, QueueDelivery, QueueWithdrawal, WITHDRAW_DEADLINE};
use crate::queue::refusals::UnreturnedReason;
use crate::queue::store::{QueueItemReader, QueueItemRecord, RecordedQueueItemState};

/// The answer a withdraw job sends its caller: each candidate's withdrawal, or the failure that
/// stopped them.
pub(super) type WithdrawReply = Result<HashMap<QueueItemId, QueueWithdrawal>, DeliveryError>;

/// A take-back's withdraws, run when the chain reaches them unless their deadline passed first.
pub(super) struct WithdrawJob {
    /// The handed messages to take back.
    candidates: Vec<QueueItemRecord>,
    /// Cancelled once the caller stops waiting.
    deadline: CancellationToken,
    /// Set when the withdraws start, under its lock, which the caller reads as it cancels.
    has_started: Arc<Mutex<bool>>,
    /// Where the withdrawals go; dropped unsent when the deadline passed first.
    reply: oneshot::Sender<WithdrawReply>,
}

/// A withdraw answered after the deadline, for the hand it was asked of.
pub(super) struct LateWithdraw {
    /// The message.
    pub(super) item: QueueItemRecord,
    /// The run it was handed for.
    handed_run_id: RunId,
    /// The hand the withdraw was asked of.
    hand_number: u64,
    /// Whether the provider had taken it.
    is_delivered: bool,
}

// Locks `flag`; it holds a plain boolean, which no holder leaves half-written.
fn lock_flag(flag: &Mutex<bool>) -> MutexGuard<'_, bool> {
    flag.lock().unwrap_or_else(PoisonError::into_inner)
}

impl QueueDelivery {
    /// Takes `items` back from their provider ahead of a change to them and says of each whether
    /// it is the queue's to change: waiting, not a starting run's opening, and not handed or
    /// given back. One a resume read is taken at once, the resume going to its provider off the
    /// session lock; any other handed one is withdrawn on the session's chain within
    /// [`WITHDRAW_DEADLINE`], and one the provider did not give back in time, or that the chain did
    /// not reach by then, reads not delivered. Called under `hold`; fails when a read or a write
    /// fails.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the run queue's edit, removal and reorder")
    )]
    pub(crate) async fn take_back(
        &self,
        hold: &KeyHold<'_, SessionId>,
        items: &[QueueItemRecord],
    ) -> Result<HashMap<QueueItemId, QueueWithdrawal>, DeliveryError> {
        let openings = &self.shared.deps.openings;
        let candidates = items.iter().filter(|item| {
            item.state == RecordedQueueItemState::Queued && !openings.is_opening(&item.id)
        });
        // Under the session lock no hand of an unhanded message joins the chain, so one not
        // handed now stays with the queue and needs no withdraw.
        let mut handed = Vec::new();
        let mut withdrawals: HashMap<QueueItemId, QueueWithdrawal> = HashMap::new();
        {
            let state = self.lock_state();
            for item in candidates {
                let withdrawal = match state.handed.get(&item.id).map(|handed| handed.route) {
                    None => QueueWithdrawal::Returned,
                    Some(HandRoute::Continue { .. }) => {
                        QueueWithdrawal::Unreturned(UnreturnedReason::Taken)
                    }
                    Some(HandRoute::Driver(_)) => {
                        handed.push(item.clone());
                        continue;
                    }
                };
                withdrawals.insert(item.id, withdrawal);
            }
        }
        if !handed.is_empty() {
            withdrawals.extend(self.withdraw_on_chain(*hold.key(), handed).await?);
        }
        let returned: Vec<QueueItemId> = withdrawals
            .iter()
            .filter(|(_, withdrawal)| **withdrawal == QueueWithdrawal::Returned)
            .map(|(item_id, _)| *item_id)
            .collect();
        let still_waiting = self
            .shared
            .deps
            .pool
            .read(ReadLength::Short, move |reader| {
                let items = QueueItemReader::new(reader);
                let mut still_waiting = HashSet::new();
                for item_id in returned {
                    if items
                        .get(&item_id)?
                        .is_some_and(|item| item.state == RecordedQueueItemState::Queued)
                    {
                        still_waiting.insert(item_id);
                    }
                }
                Ok::<_, DeliveryError>(still_waiting)
            })
            .await?;
        Ok(items
            .iter()
            .map(|item| {
                let withdrawal = match withdrawals.get(&item.id) {
                    Some(QueueWithdrawal::Returned) if still_waiting.contains(&item.id) => {
                        QueueWithdrawal::Returned
                    }
                    Some(QueueWithdrawal::Unreturned(reason)) => {
                        QueueWithdrawal::Unreturned(*reason)
                    }
                    Some(QueueWithdrawal::Returned) | None => {
                        QueueWithdrawal::Unreturned(UnreturnedReason::Taken)
                    }
                };
                (item.id, withdrawal)
            })
            .collect())
    }

    // Withdraws the handed `candidates` on the session's chain within the deadline; each the chain
    // did not reach in time reads not delivered.
    async fn withdraw_on_chain(
        &self,
        session_id: SessionId,
        candidates: Vec<QueueItemRecord>,
    ) -> Result<HashMap<QueueItemId, QueueWithdrawal>, DeliveryError> {
        let deadline = CancellationToken::new();
        let has_started = Arc::new(Mutex::new(false));
        let (reply_sender, mut reply) = oneshot::channel();
        let job = WithdrawJob {
            candidates: candidates.clone(),
            deadline: deadline.clone(),
            has_started: Arc::clone(&has_started),
            reply: reply_sender,
        };
        self.push(session_id, ChainJob::Withdraw(job));
        // A job the chain dropped unanswered was not reached either.
        let answered = if let Some(answered) =
            wait_within(Pin::new(&mut reply), WITHDRAW_DEADLINE, None).await
        {
            answered.ok()
        } else {
            let is_started = {
                let is_started = lock_flag(&has_started);
                deadline.cancel();
                *is_started
            };
            // Started withdraws are bounded by the same deadline, so they answer at once.
            if is_started { reply.await.ok() } else { None }
        };
        if let Some(answer) = answered {
            return answer;
        }
        for item in &candidates {
            self.record_unreturned(item, "waited past the deadline behind earlier hands")
                .await?;
        }
        Ok(candidates
            .iter()
            .map(|item| {
                let reason = UnreturnedReason::NotDelivered;
                (item.id, QueueWithdrawal::Unreturned(reason))
            })
            .collect())
    }

    /// Withdraws every candidate at once, unless the caller's deadline passed before the chain
    /// reached the job: the caller has then answered for them, and nothing reaches the driver.
    pub(super) async fn withdraw_all(&self, session_id: SessionId, job: WithdrawJob) {
        let WithdrawJob {
            candidates,
            deadline,
            has_started,
            reply,
        } = job;
        {
            let mut is_started = lock_flag(&has_started);
            if deadline.is_cancelled() {
                return;
            }
            *is_started = true;
        }
        let withdrawals = join_all(
            candidates
                .iter()
                .map(|item| self.withdraw(session_id, item, &deadline)),
        )
        .await;
        let answer: WithdrawReply = candidates
            .iter()
            .zip(withdrawals)
            .map(|(item, withdrawal)| withdrawal.map(|withdrawal| (item.id, withdrawal)))
            .collect();
        // A caller that left reads no failure, so the log keeps it.
        if let Err(Err(error)) = reply.send(answer) {
            tracing::error!(
                session_id = %session_id,
                error = &error as &(dyn Error + 'static),
                "taking queued messages back from their provider failed"
            );
        }
    }

    // One withdraw of a take-back, bounded by the take-back's deadline. A message the provider
    // does not answer for in time stays handed, since the provider may still start a turn with
    // it, and its late answer is settled on the chain.
    async fn withdraw(
        &self,
        session_id: SessionId,
        item: &QueueItemRecord,
        deadline: &CancellationToken,
    ) -> Result<QueueWithdrawal, DeliveryError> {
        let handed = self.lock_state().handed.get(&item.id).copied();
        let Some(handed) = handed else {
            return Ok(QueueWithdrawal::Returned);
        };
        let can_withdraw = match handed.route {
            HandRoute::Driver(handing) => handing.can_withdraw,
            HandRoute::Continue { .. } => false,
        };
        if !can_withdraw {
            return Ok(QueueWithdrawal::Unreturned(UnreturnedReason::Taken));
        }
        let driver = read_run_driver::<DeliveryError>(
            &self.shared.deps.pool,
            &self.shared.deps.providers,
            handed.run_id,
        )
        .await?;
        let params = WithdrawQueuedMessageParams {
            session_id,
            run_id: handed.run_id,
            client_idempotency_key: item.id,
        };
        let mut withdrawing = Box::pin(async move { driver.withdraw_queued_message(params).await });
        match wait_within(withdrawing.as_mut(), WITHDRAW_DEADLINE, Some(deadline)).await {
            None => {
                let delivery = self.clone();
                let late_item = item.clone();
                self.shared.tasks.spawn(
                    async move {
                        let is_delivered = match withdrawing.await {
                            Ok(answer) => {
                                tracing::info!(
                                    session_id = %session_id,
                                    queue_item_id = %late_item.id,
                                    answer = ?answer,
                                    "the provider answered a withdraw after the deadline"
                                );
                                matches!(answer, WithdrawQueuedMessageResult::AlreadyDelivered {})
                            }
                            Err(error) => {
                                tracing::warn!(
                                    session_id = %session_id,
                                    queue_item_id = %late_item.id,
                                    error = &error as &(dyn Error + 'static),
                                    "a withdraw failed after the deadline"
                                );
                                false
                            }
                        };
                        let late = LateWithdraw {
                            item: late_item,
                            handed_run_id: handed.run_id,
                            hand_number: handed.hand_number,
                            is_delivered,
                        };
                        delivery.push(session_id, ChainJob::LateWithdraw(late));
                    }
                    .instrument(tracing::Span::current()),
                );
                self.record_unreturned(item, "was not answered within the deadline")
                    .await?;
                Ok(QueueWithdrawal::Unreturned(UnreturnedReason::NotDelivered))
            }
            Some(Err(error)) => {
                self.forget_hand(item.id);
                tracing::warn!(
                    session_id = %session_id,
                    queue_item_id = %item.id,
                    error = &error as &(dyn Error + 'static),
                    "a withdraw of a queued message failed"
                );
                self.record_unreturned(item, "failed").await?;
                Ok(QueueWithdrawal::Unreturned(UnreturnedReason::NotDelivered))
            }
            Some(Ok(WithdrawQueuedMessageResult::AlreadyDelivered {})) => {
                self.record_admission(item, handed.run_id).await?;
                Ok(QueueWithdrawal::Unreturned(UnreturnedReason::Taken))
            }
            Some(Ok(WithdrawQueuedMessageResult::Withdrawn {})) => {
                self.forget_hand(item.id);
                Ok(QueueWithdrawal::Returned)
            }
        }
    }

    /// Settles a withdraw answered past the deadline, unless the message's hand changed since the
    /// withdraw saw it: one the provider had taken is admitted late, and with the message no
    /// longer the provider's to keep, its interrupted run is continued. Fails when a read or the
    /// admission's write fails.
    pub(super) async fn settle_late_withdraw(
        &self,
        session_id: SessionId,
        late: LateWithdraw,
    ) -> Result<(), DeliveryError> {
        {
            let mut state = self.lock_state();
            let is_same_hand = state
                .handed
                .get(&late.item.id)
                .is_some_and(|handed| handed.hand_number == late.hand_number);
            if !is_same_hand {
                return Ok(());
            }
            state.handed.remove(&late.item.id);
        }
        if late.is_delivered {
            self.admit_undelivered(late.item.id, late.handed_run_id)
                .await?;
        }
        self.continue_if_interrupted(session_id, late.handed_run_id)
            .await
    }

    // A handed message its provider did not give back: whether it reaches the agent is unknown, so
    // while it still waits it reads not delivered and can be sent again.
    async fn record_unreturned(
        &self,
        item: &QueueItemRecord,
        what: &str,
    ) -> Result<(), DeliveryError> {
        tracing::warn!(
            session_id = %item.session_id,
            queue_item_id = %item.id,
            "the withdraw of a queued message {what}"
        );
        let is_waiting = self
            .read_item(item.id)
            .await?
            .is_some_and(|current| current.state == RecordedQueueItemState::Queued);
        if is_waiting {
            self.record_failed(item).await?;
        }
        Ok(())
    }
}
