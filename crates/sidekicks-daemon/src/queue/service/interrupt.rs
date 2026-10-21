//! The run queue as an interrupt uses it: the hold on a run's hands while a person's interrupt
//! settles, the run's end with the interrupt's choice for its waiting messages in the same write,
//! the release that applies that choice to a run that ended first, and `Send now`, which hands a
//! waiting message ahead of what its provider holds instead of interrupting.

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::InterventionId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;

use super::{EMPTIED_RUN_DETAIL, RunQueue};
use crate::database::connection::read_pool::ReadLength;
use crate::interventions::interrupt_queue::{
    InterruptCause, InterruptChoice, InterruptEnd, InterruptQueue, InterruptQueueError, SendNow,
    SendNowOutcome,
};
use crate::keyed_lock::KeyHold;
use crate::provider::driver::run_control::InterruptPendingChoice;
use crate::queue::delivery::{InterruptHoldRelease, QueueWithdrawal, reordered_of};
use crate::queue::error::QueueError;
use crate::queue::refusals::{
    UnreturnedReason, left_queue_refusal, queue_item_not_found, unreturned_refusal,
};
use crate::queue::store::send_now::{mark_sent_now_statement, read_sent_now};
use crate::queue::store::{QueueItemOutcome, QueueItemRecord, RecordedQueueItemState};
use crate::session::run::read::{read_run_through, safe_run_version};
use crate::session::run::refusals::RunRefusal;

impl InterruptQueue for RunQueue {
    fn send_now(
        &self,
        send: SendNow,
    ) -> BoxFuture<'_, Result<SendNowOutcome, InterruptQueueError>> {
        async move { Ok(self.send_now_under_hold(send).await?) }.boxed()
    }

    fn hold_for_interrupt(
        &self,
        run_id: RunId,
        intervention_id: InterventionId,
        choice: InterruptChoice,
    ) -> BoxFuture<'_, Result<(), InterruptQueueError>> {
        async move {
            let session_id = self.session_of_run(run_id).await?;
            let hold = self.session_lock.acquire(session_id).await;
            self.delivery
                .hold_for_interrupt(&hold, run_id, intervention_id)
                .await;
            let Some(moved) = self.lifecycle.take_moved_leftovers(run_id) else {
                return Ok(());
            };
            let mut waiting = Vec::with_capacity(moved.len());
            for item_id in moved {
                if let Some(item) = self.read_item(item_id).await?
                    && item.state == RecordedQueueItemState::Queued
                {
                    waiting.push(item);
                }
            }
            if !waiting.is_empty() {
                self.apply_choice_to_waiting(&hold, choice, waiting).await?;
            }
            Ok(())
        }
        .boxed()
    }

    fn end_run_for_interrupt(
        &self,
        end: InterruptEnd,
    ) -> BoxFuture<'_, Result<bool, InterruptQueueError>> {
        async move { Ok(self.end_run_under_hold(end).await?) }.boxed()
    }

    fn release_interrupt(
        &self,
        run_id: RunId,
        intervention_id: InterventionId,
        choice: InterruptChoice,
    ) -> BoxFuture<'_, Result<(), InterruptQueueError>> {
        async move {
            let session_id = self.session_of_run(run_id).await?;
            let hold = self.session_lock.acquire(session_id).await;
            match self
                .delivery
                .release_interrupt_hold(run_id, intervention_id)
            {
                InterruptHoldRelease::NotHeld | InterruptHoldRelease::StillHeld => return Ok(()),
                InterruptHoldRelease::Released => {}
            }
            let applied = self.apply_choice_if_ended(&hold, run_id, choice).await;
            let released = self.settle_released(&hold, run_id).await;
            applied?;
            released?;
            Ok(())
        }
        .boxed()
    }
}

impl RunQueue {
    // Under the session's hold and on the hand chain, so no hand, withdraw or replay moves a
    // message under the write: the run's end with the interrupt's writes for its messages. Once
    // written, the hold of every interrupt the end settled goes.
    async fn end_run_under_hold(&self, end: InterruptEnd) -> Result<bool, QueueError> {
        let InterruptEnd {
            run_id,
            accepted_run_version,
            cause,
            cancelled,
            verdict,
        } = end;
        let session_id = self.session_of_run(run_id).await?;
        let hold = self.session_lock.acquire(session_id).await;
        let (pending, deliver_first, limit, cut_turn) = match cause {
            InterruptCause::Person(choice) => (choice.pending, choice.deliver_first, None, None),
            InterruptCause::Limit { limit, cut_turn } => (
                InterruptPendingChoice::KeepWaiting,
                None,
                Some(limit),
                cut_turn,
            ),
        };
        let settled = verdict.settled_interventions.clone();
        let is_ended = self
            .delivery
            .run_between_hands(session_id, async {
                let writes = self
                    .delivery
                    .interrupt_end_writes(run_id, pending, deliver_first, &cancelled)
                    .await?;
                let mut companions = verdict;
                companions.statements.extend(writes.statements);
                companions.preceding_events.extend(writes.preceding_events);
                let is_ended = self
                    .engine
                    .end_run_for_interrupt(
                        run_id,
                        accepted_run_version,
                        limit,
                        cut_turn,
                        companions,
                    )
                    .await?;
                if is_ended && !writes.changed.is_empty() {
                    if pending == InterruptPendingChoice::ReturnToDraft {
                        // No provider takes these messages from the run that ended.
                        let item_ids: Vec<_> = writes.changed.iter().map(|item| item.id).collect();
                        self.delivery.forget(&item_ids);
                    }
                    self.recorder
                        .raise_committed(&writes.changed, writes.moves_order);
                }
                Ok::<_, QueueError>(is_ended)
            })
            .await?;
        if is_ended {
            let mut is_released = false;
            for intervention_id in settled {
                is_released |= self
                    .delivery
                    .release_interrupt_hold(run_id, intervention_id)
                    == InterruptHoldRelease::Released;
            }
            if is_released {
                self.settle_released(&hold, run_id).await?;
            }
        }
        Ok(is_ended)
    }

    // A person's `Send now` under the session's hold: the rows ahead of the message and the
    // message are taken back, the message is marked with the request's key and handed first with
    // priority, and the rows ahead follow in their order. A run that takes no message now leaves
    // the request to the interrupt.
    async fn send_now_under_hold(&self, send: SendNow) -> Result<SendNowOutcome, QueueError> {
        let SendNow {
            run_id,
            expected_run_version,
            item_id,
            key,
            intervention_id,
        } = send;
        let session_id = self.session_of_run(run_id).await?;
        let hold = self.session_lock.acquire(session_id).await;
        let Some(run) = read_run_through::<QueueError>(&self.pool, run_id).await? else {
            return Err(RunRefusal::NotFound { run_id }.into());
        };
        if safe_run_version(run.version) != expected_run_version {
            return Ok(SendNowOutcome::Expired);
        }
        let takes_messages = matches!(run.state, RunState::Running | RunState::WaitingForApproval);
        if !takes_messages || self.delivery.is_held_for_interrupt(run_id) {
            return Ok(SendNowOutcome::Interrupt);
        }
        let Some(item) = self
            .read_item(item_id)
            .await?
            .filter(|item| item.session_id == session_id && item.child_handle.is_none())
        else {
            return Ok(SendNowOutcome::Refused(queue_item_not_found(item_id)));
        };
        if item.state != RecordedQueueItemState::Queued {
            return Ok(SendNowOutcome::Refused(left_queue_refusal(&item)));
        }
        if item.target_run_id != Some(run_id) {
            return Ok(SendNowOutcome::Interrupt);
        }
        let mut taken_back: Vec<QueueItemRecord> = self
            .read_waiting(run_id)
            .await?
            .into_iter()
            .filter(|ahead| ahead.child_handle.is_none() && ahead.position < item.position)
            .collect();
        taken_back.push(item.clone());
        let withdrawal = self
            .delivery
            .take_back(&hold, &taken_back)
            .await?
            .get(&item.id)
            .copied()
            .unwrap_or(QueueWithdrawal::Unreturned(UnreturnedReason::Taken));
        if let QueueWithdrawal::Unreturned(reason) = withdrawal {
            // What was taken back goes again in its order.
            self.delivery.hand_waiting(&hold, run_id).await?;
            return Ok(SendNowOutcome::Refused(unreturned_refusal(item.id, reason)));
        }
        let marked = self
            .writer
            .write(vec![mark_sent_now_statement(
                &item.id,
                &key,
                &intervention_id,
                &WireInstant::now(),
            )])
            .await;
        if let Err(error) = marked {
            self.delivery.hand_waiting(&hold, run_id).await?;
            if error.refused_statement_index().is_none() {
                return Err(error.into());
            }
            // A retry under the same key marked it first, or the message left the queue.
            let sent = self
                .pool
                .read(ReadLength::Short, move |reader| {
                    Ok::<_, QueueError>(read_sent_now(reader, &session_id, &key)?)
                })
                .await?;
            if sent.is_some_and(|sent| sent.item_id == item.id) {
                return Ok(SendNowOutcome::Sent);
            }
            let left = self.read_item(item.id).await?;
            return Ok(SendNowOutcome::Refused(match left {
                Some(left) => left_queue_refusal(&left),
                None => queue_item_not_found(item.id),
            }));
        }
        self.delivery.hand_first(&hold, run_id, item).await?;
        Ok(SendNowOutcome::Sent)
    }

    // Applies `choice` to the lead's messages still waiting for `run_id` when the run has ended
    // before the interrupt could end it.
    async fn apply_choice_if_ended(
        &self,
        hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
        choice: InterruptChoice,
    ) -> Result<(), QueueError> {
        let has_ended = read_run_through::<QueueError>(&self.pool, run_id)
            .await?
            .is_some_and(|run| run.state.is_terminal());
        if !has_ended {
            return Ok(());
        }
        let waiting: Vec<QueueItemRecord> = self
            .read_waiting(run_id)
            .await?
            .into_iter()
            .filter(|item| item.child_handle.is_none())
            .collect();
        self.apply_choice_to_waiting(hold, choice, waiting).await
    }

    // Applies an interrupt's choice to `waiting`, lead messages that waited for its run when the
    // run ended before the interrupt could end it. A cancel that leaves a queued run they were
    // moved on to with no message to start with ends that run, as a removal of its last one does.
    async fn apply_choice_to_waiting(
        &self,
        hold: &KeyHold<'_, SessionId>,
        choice: InterruptChoice,
        waiting: Vec<QueueItemRecord>,
    ) -> Result<(), QueueError> {
        match choice.pending {
            InterruptPendingChoice::NextTurn => {
                // What the provider holds goes first in the turn it starts with it.
                let movable: Vec<QueueItemRecord> = waiting
                    .into_iter()
                    .filter(|item| !self.delivery.is_handed(&item.id))
                    .collect();
                if let Some(ordered) = reordered_of(&movable, choice.deliver_first)
                    && ordered.first().map(|item| item.id) != movable.first().map(|item| item.id)
                {
                    self.recorder
                        .record_order(&ordered, &WireInstant::now())
                        .await?;
                }
                Ok(())
            }
            InterruptPendingChoice::ReturnToDraft => {
                let withdrawals = self.delivery.take_back(hold, &waiting).await?;
                let mut run_ids: Vec<RunId> = Vec::new();
                for item in waiting {
                    if withdrawals.get(&item.id) != Some(&QueueWithdrawal::Returned) {
                        continue;
                    }
                    self.recorder
                        .record_outcome(&item, QueueItemOutcome::Canceled, &WireInstant::now())
                        .await?;
                    self.delivery.forget(&[item.id]);
                    if let Some(run_id) = item.target_run_id
                        && !run_ids.contains(&run_id)
                    {
                        run_ids.push(run_id);
                    }
                }
                for run_id in run_ids {
                    if self.is_queued_run_emptied_by(run_id, &[]).await? {
                        self.admission
                            .end_queued_run(hold, run_id, Vec::new(), EMPTIED_RUN_DETAIL.clone())
                            .await?;
                    }
                }
                Ok(())
            }
            // The daemon's own at a limit holds no queue.
            InterruptPendingChoice::KeepWaiting => Ok(()),
        }
    }

    // What an interrupt's hold held back once it went: an end of the run seen meanwhile, else the
    // messages a live run is handed.
    async fn settle_released(
        &self,
        hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
    ) -> Result<(), QueueError> {
        self.lifecycle
            .settle_end_after_interrupt(hold, run_id)
            .await?;
        self.delivery.hand_waiting(hold, run_id).await?;
        Ok(())
    }

    async fn session_of_run(&self, run_id: RunId) -> Result<SessionId, QueueError> {
        read_run_through::<QueueError>(&self.pool, run_id)
            .await?
            .map(|run| run.session_id)
            .ok_or_else(|| RunRefusal::NotFound { run_id }.into())
    }
}
