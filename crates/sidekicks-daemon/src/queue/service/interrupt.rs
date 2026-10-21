//! The run queue as an interrupt uses it: the hold on a run's hands while a person's interrupt
//! settles, the run's end with the interrupt's choice for its waiting messages in the same write,
//! the release that applies that choice to a run that ended first, recorded on the interrupt's row
//! when it fails and settled again at the session's next hold, and `Send now`, which hands a
//! waiting message ahead of what its provider holds instead of interrupting, or keeps it first
//! and marked for a run that takes no message now.

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
use crate::interventions::store::{
    UnreleasedInterrupt, clear_unreleased_statement, read_unreleased_interrupts,
    record_unreleased_statement,
};
use crate::keyed_lock::KeyHold;
use crate::provider::driver::run_control::InterruptPendingChoice;
use crate::queue::delivery::{InterruptHoldRelease, QueueWithdrawal, reordered_of};
use crate::queue::error::QueueError;
use crate::queue::refusals::{
    UnreturnedReason, left_queue_refusal, queue_item_not_found, unreturned_refusal,
};
use crate::queue::session_lock::UnreleasedInterrupts;
use crate::queue::store::send_now::{SentNow, mark_sent_now_statement, record_sent_now_statement};
use crate::queue::store::{
    QueueItemOutcome, QueueItemRecord, RecordedQueueItemState, placement_statements,
};
use crate::session::run::read::{read_run_through, safe_run_version};
use crate::session::run::refusals::RunRefusal;

// What a release left unsettled records once its choice settled, applied or not due: nothing more
// to apply, only what the hold held back to settle.
const CHOICE_SETTLED: InterruptChoice = InterruptChoice {
    pending: InterruptPendingChoice::KeepWaiting,
    deliver_first: None,
};

// How the settle of a released hold went: whether the interrupt's choice is settled (applied, or
// not due), and the whole settle's outcome.
struct ReleaseSettle {
    is_choice_settled: bool,
    settled: Result<(), QueueError>,
}

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
            let hold = self.session_lock.hold_session(session_id).await;
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
            Ok(self
                .release_under_hold(session_id, run_id, intervention_id, choice)
                .await?)
        }
        .boxed()
    }

    fn release_interrupt_at_run_end(
        &self,
        run_id: RunId,
        intervention_id: InterventionId,
        choice: InterruptChoice,
    ) -> BoxFuture<'_, Result<(), InterruptQueueError>> {
        async move {
            let session_id = self.session_of_run(run_id).await?;
            // A run's end written under the session's hold lets its settled interrupts go from
            // inside that hold, so the release waits for the hold on a task of its own.
            let queue = self.this.clone();
            self.releases.spawn(async move {
                let Some(queue) = queue.upgrade() else {
                    return;
                };
                if let Err(error) = queue
                    .release_under_hold(session_id, run_id, intervention_id, choice)
                    .await
                {
                    tracing::error!(
                        session_id = %session_id,
                        run_id = %run_id,
                        error = &error as &(dyn std::error::Error + 'static),
                        "settling what an interrupt's released hold held back failed; the \
                         session's next hold settles it again"
                    );
                }
            });
            Ok(())
        }
        .boxed()
    }
}

impl UnreleasedInterrupts for RunQueue {
    fn settle_unreleased<'call>(
        &'call self,
        hold: &'call KeyHold<'_, SessionId>,
    ) -> BoxFuture<'call, Result<(), QueueError>> {
        async move {
            let session_id = *hold.key();
            let unreleased = self
                .pool
                .read(ReadLength::Short, move |reader| {
                    Ok::<_, QueueError>(read_unreleased_interrupts(reader, &session_id)?)
                })
                .await?;
            let mut first_failure = None;
            let mut note_failure = |run_id: RunId, error: QueueError| {
                if first_failure.is_some() {
                    tracing::error!(
                        session_id = %session_id,
                        run_id = %run_id,
                        error = &error as &(dyn std::error::Error + 'static),
                        "settling again what an interrupt's release left unsettled failed"
                    );
                } else {
                    first_failure = Some(error);
                }
            };
            for interrupt in unreleased {
                if let Err(error) = self.settle_unreleased_interrupt(hold, interrupt).await {
                    note_failure(interrupt.run_id, error);
                }
            }
            // A run's end held back for an interrupt whose release found no row to record its
            // failed settle on.
            for run_id in self.lifecycle.ends_no_longer_held(hold) {
                if let Err(error) = self
                    .lifecycle
                    .settle_end_after_interrupt(hold, run_id)
                    .await
                {
                    note_failure(run_id, error);
                }
            }
            first_failure.map_or(Ok(()), Err)
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
        let hold = self.session_lock.hold_session(session_id).await;
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

    // A person's `Send now` under the session's hold. Every lead row waiting for the message's run
    // is taken back, and the message is marked, put first and recorded under the request's key on
    // the run in one write. A run that takes a message now, a person's card open among them, is
    // handed it first with priority and the rest after; any other run keeps it first and marked
    // for its next hand. A message a `Send now` marked before, under this key or another, keeps
    // that mark and answers its id, which the key records too: as sent while its provider holds
    // it, else after it goes first again. Every error after the take-back hands the rows again
    // first.
    async fn send_now_under_hold(&self, send: SendNow) -> Result<SendNowOutcome, QueueError> {
        let SendNow {
            run_id,
            expected_run_version,
            item_id,
            key,
            intervention_id,
        } = send;
        let session_id = self.session_of_run(run_id).await?;
        let hold = self.session_lock.hold_session(session_id).await;
        let Some(run) = read_run_through::<QueueError>(&self.pool, run_id).await? else {
            return Err(RunRefusal::NotFound { run_id }.into());
        };
        if safe_run_version(run.version) != expected_run_version {
            return Ok(SendNowOutcome::Expired);
        }
        let Some((item, item_run_id)) = self
            .read_item(item_id)
            .await?
            .filter(|item| item.session_id == session_id && item.child_handle.is_none())
            .and_then(|item| item.target_run_id.map(|item_run_id| (item, item_run_id)))
        else {
            return Ok(SendNowOutcome::Refused(queue_item_not_found(item_id)));
        };
        if item.state != RecordedQueueItemState::Queued {
            return Ok(SendNowOutcome::Refused(left_queue_refusal(&item)));
        }
        let marked_id = item.sent_now_id;
        let sent = SentNow {
            item_id: item.id,
            intervention_id: marked_id.unwrap_or(intervention_id),
        };
        if marked_id.is_some() && self.delivery.is_handed(&item.id) {
            self.writer
                .write(vec![record_sent_now_statement(
                    &run_id,
                    &key,
                    &sent,
                    &WireInstant::now(),
                )])
                .await?;
            return Ok(SendNowOutcome::Sent {
                intervention_id: sent.intervention_id,
            });
        }
        let takes_now = item_run_id == run_id
            && matches!(
                run.state,
                RunState::Running | RunState::WaitingForApproval | RunState::WaitingForInput
            )
            && !self.delivery.is_held_for_interrupt(run_id);
        let waiting: Vec<QueueItemRecord> = self
            .read_waiting(item_run_id)
            .await?
            .into_iter()
            .filter(|waiting| waiting.child_handle.is_none())
            .collect();
        let withdrawals = self.delivery.take_back(&hold, &waiting).await?;
        let returned: Vec<QueueItemRecord> = waiting
            .into_iter()
            .filter(|waiting| withdrawals.get(&waiting.id) == Some(&QueueWithdrawal::Returned))
            .collect();
        if !returned.iter().any(|returned| returned.id == item.id) {
            let reason = match withdrawals.get(&item.id) {
                Some(QueueWithdrawal::Unreturned(reason)) => *reason,
                Some(QueueWithdrawal::Returned) | None => UnreturnedReason::Taken,
            };
            // What was taken back goes again in its order.
            self.delivery.hand_waiting(&hold, item_run_id).await?;
            return Ok(SendNowOutcome::Refused(unreturned_refusal(item.id, reason)));
        }
        let now = WireInstant::now();
        let ordered = reordered_of(&returned, Some(item.id))
            .expect("the message sent now is among the rows given back");
        let mut statements = Vec::with_capacity(ordered.len() + 2);
        if marked_id.is_none() {
            statements.push(mark_sent_now_statement(
                &item.id,
                &sent.intervention_id,
                &now,
            ));
        }
        statements.push(record_sent_now_statement(&run_id, &key, &sent, &now));
        statements.extend(placement_statements(&ordered, &now));
        if let Err(error) = self.writer.write(statements).await {
            self.delivery.hand_waiting(&hold, item_run_id).await?;
            if error.refused_statement_index().is_none() {
                return Err(error.into());
            }
            // The message left the queue.
            return Ok(SendNowOutcome::Refused(
                match self.read_item(item.id).await? {
                    Some(left) => left_queue_refusal(&left),
                    None => queue_item_not_found(item.id),
                },
            ));
        }
        self.recorder.raise_committed(&ordered, true);
        let handed = if takes_now {
            let item = QueueItemRecord {
                sent_now_id: Some(sent.intervention_id),
                ..item
            };
            self.delivery.hand_first(&hold, run_id, item).await
        } else {
            self.delivery.hand_waiting(&hold, item_run_id).await
        };
        if let Err(error) = handed {
            self.delivery.hand_waiting(&hold, item_run_id).await?;
            return Err(error.into());
        }
        Ok(SendNowOutcome::Sent {
            intervention_id: sent.intervention_id,
        })
    }

    // Lets go the hold `intervention_id` took on `run_id` under the session's hold; the run's last
    // hold going applies `choice` to a run that ended first and settles what the hold held back. A
    // settle that fails is recorded on the interrupt's row, since no hold is left to retry it: the
    // choice, or `keepWaiting` once the choice is settled, so a retry applies it no second time.
    async fn release_under_hold(
        &self,
        session_id: SessionId,
        run_id: RunId,
        intervention_id: InterventionId,
        choice: InterruptChoice,
    ) -> Result<(), QueueError> {
        let hold = self.session_lock.hold_session(session_id).await;
        match self
            .delivery
            .release_interrupt_hold(run_id, intervention_id)
        {
            InterruptHoldRelease::NotHeld | InterruptHoldRelease::StillHeld => return Ok(()),
            InterruptHoldRelease::Released => {}
        }
        let ReleaseSettle {
            is_choice_settled,
            settled,
        } = self.settle_release(&hold, run_id, choice).await;
        let left = if is_choice_settled {
            CHOICE_SETTLED
        } else {
            choice
        };
        if settled.is_err()
            && let Err(error) = self
                .writer
                .write(vec![record_unreleased_statement(&intervention_id, left)])
                .await
        {
            tracing::error!(
                session_id = %session_id,
                run_id = %run_id,
                error = &error as &(dyn std::error::Error + 'static),
                "recording an interrupt's unsettled release failed; the session's next hold \
                 settles a run's end it held back, and applies no choice"
            );
        }
        settled
    }

    // What the last hold of `run_id` going settles: `choice` applied to a run that ended first,
    // and what the hold held back.
    async fn settle_release(
        &self,
        hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
        choice: InterruptChoice,
    ) -> ReleaseSettle {
        let applied = self.apply_choice_if_ended(hold, run_id, choice).await;
        let released = self.settle_released(hold, run_id).await;
        ReleaseSettle {
            is_choice_settled: applied.is_ok(),
            settled: applied.and(released),
        }
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

    // Settles one release recorded unsettled, under `hold`, and clears its record; one that fails
    // again after its choice settled is recorded as `keepWaiting`, so the next applies it no second
    // time.
    async fn settle_unreleased_interrupt(
        &self,
        hold: &KeyHold<'_, SessionId>,
        unreleased: UnreleasedInterrupt,
    ) -> Result<(), QueueError> {
        let UnreleasedInterrupt {
            intervention_id,
            run_id,
            choice,
        } = unreleased;
        let ReleaseSettle {
            is_choice_settled,
            settled,
        } = self.settle_release(hold, run_id, choice).await;
        if let Err(error) = settled {
            if is_choice_settled
                && choice != CHOICE_SETTLED
                && let Err(rewrite_error) = self
                    .writer
                    .write(vec![record_unreleased_statement(
                        &intervention_id,
                        CHOICE_SETTLED,
                    )])
                    .await
            {
                tracing::error!(
                    session_id = %hold.key(),
                    run_id = %run_id,
                    error = &rewrite_error as &(dyn std::error::Error + 'static),
                    "recording an interrupt's choice as applied failed; its next settle applies it \
                     again"
                );
            }
            return Err(error);
        }
        self.writer
            .write(vec![clear_unreleased_statement(&intervention_id)])
            .await?;
        Ok(())
    }

    async fn session_of_run(&self, run_id: RunId) -> Result<SessionId, QueueError> {
        read_run_through::<QueueError>(&self.pool, run_id)
            .await?
            .map(|run| run.session_id)
            .ok_or_else(|| RunRefusal::NotFound { run_id }.into())
    }
}
