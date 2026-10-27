//! The messages a paused run's resume delivers: read and marked handed under the session lock,
//! admitted once the driver continued the run, given back when it did not, and kept when the
//! resume went out with no answer back. A kept message is read by no later continue and stays
//! handed past the run's end, until the provider shows it took it or its own record says what
//! became of it, which is final only once no live provider process still holds it.

use futures::future::BoxFuture;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::id::SessionId;

use crate::delivery::state::{HandRoute, is_kept_by_process};
use crate::delivery::{DeliveryError, QueueDelivery};
use sidekicks_provider::driver::message_handing::MessageHanding;
use sidekicks_provider::driver::run_control::WaitingMessage;
use sidekicks_provider::port::run_pause::{ContinuedMessages, ContinuedMessagesError};
use sidekicks_session::queue_store::RecordedQueueItemState;
use sidekicks_std::keyed_lock::KeyHold;

impl QueueDelivery {
    // The unhanded lead messages waiting for `run_id` of `session_id`, a continue that did not go
    // read again (one a resume keeps excepted), each marked handed by the continue to a provider
    // that takes messages as `handing` says, in the queue's order.
    async fn read_continued(
        &self,
        session_id: SessionId,
        run_id: RunId,
        handing: MessageHanding,
    ) -> Result<Vec<WaitingMessage>, DeliveryError> {
        let lead_waiting = self.lead_waiting(self.read_waiting(run_id).await?, false);
        let process = self.shared.deps.processes.process_identity(&session_id);
        let items = {
            let mut state = self.lock_state();
            let items = state.unhanded_of(lead_waiting, true);
            let route = HandRoute::Continue {
                is_kept: false,
                handing,
            };
            state.mark_handed(&items, run_id, route, process);
            items
        };
        Ok(items
            .into_iter()
            .map(|item| WaitingMessage {
                id: item.id,
                attachments: item.body.attachment_ids(),
                skills: item.body.skills.unwrap_or_default(),
                content: item.body.content,
            })
            .collect())
    }

    // Admits the messages this resume of `run_id` read; one an earlier resume keeps waits for its
    // own settle.
    async fn admit_continued(&self, run_id: RunId) -> Result<(), DeliveryError> {
        let continued = self.lock_state().continued_of(run_id, false);
        for item_id in continued {
            if let Some(item) = self.read_item(item_id).await? {
                self.record_admission(&item, run_id).await?;
            }
        }
        Ok(())
    }

    // Settles each of `settled` that a resume of `run_id` kept, its outcome known: one of `taken`
    // still waiting admitted into the run, the provider having taken it, every other one given
    // back to go once more under its own id, and one no longer waiting forgotten.
    async fn settle_kept_continue(
        &self,
        run_id: RunId,
        settled: &[QueueItemId],
        taken: &[QueueItemId],
    ) -> Result<(), DeliveryError> {
        let kept = self.lock_state().continued_of(run_id, true);
        for item_id in kept.into_iter().filter(|item_id| settled.contains(item_id)) {
            match self.read_item(item_id).await? {
                Some(item)
                    if item.state == RecordedQueueItemState::Queued && taken.contains(&item_id) =>
                {
                    self.record_admission(&item, run_id).await?;
                }
                Some(_) | None => self.forget_hand(item_id),
            }
        }
        Ok(())
    }

    // Ends each of `message_ids` that a resume of `run_id` kept not delivered, the provider's
    // record of it unreadable, so the person decides whether to send it again; one no longer
    // waiting is forgotten.
    async fn fail_kept_continue(
        &self,
        run_id: RunId,
        message_ids: &[QueueItemId],
    ) -> Result<(), DeliveryError> {
        let kept = self.lock_state().continued_of(run_id, true);
        for item_id in kept
            .into_iter()
            .filter(|item_id| message_ids.contains(item_id))
        {
            match self.read_item(item_id).await? {
                Some(item) if item.state == RecordedQueueItemState::Queued => {
                    let failed = self.record_failed(&item).await;
                    self.forget_hand(item_id);
                    failed?;
                }
                Some(_) | None => self.forget_hand(item_id),
            }
        }
        Ok(())
    }
}

impl ContinuedMessages for QueueDelivery {
    fn hold_session(&self, session_id: SessionId) -> BoxFuture<'_, KeyHold<'_, SessionId>> {
        Box::pin(self.shared.deps.session_lock.hold_session(session_id))
    }

    fn read(
        &self,
        hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
        handing: MessageHanding,
    ) -> BoxFuture<'_, Result<Vec<WaitingMessage>, ContinuedMessagesError>> {
        let session_id = *hold.key();
        Box::pin(async move { Ok(self.read_continued(session_id, run_id, handing).await?) })
    }

    fn admit(
        &self,
        _hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
    ) -> BoxFuture<'_, Result<(), ContinuedMessagesError>> {
        Box::pin(async move { Ok(self.admit_continued(run_id).await?) })
    }

    fn release(
        &self,
        _hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
    ) -> BoxFuture<'_, Result<(), ContinuedMessagesError>> {
        // A message an earlier resume keeps stays kept until its own settle.
        self.lock_state().retain_hands(|handed| {
            handed.run_id != run_id
                || !matches!(handed.route, HandRoute::Continue { is_kept: false, .. })
        });
        Box::pin(async { Ok(()) })
    }

    fn keep(&self, _hold: &KeyHold<'_, SessionId>, run_id: RunId) {
        for handed in self.lock_state().hands_mut() {
            if let HandRoute::Continue {
                is_kept: false,
                handing,
            } = handed.route
                && handed.run_id == run_id
            {
                handed.route = HandRoute::Continue {
                    is_kept: true,
                    handing,
                };
            }
        }
    }

    fn kept(&self, _hold: &KeyHold<'_, SessionId>, run_id: RunId) -> Vec<QueueItemId> {
        self.lock_state().continued_of(run_id, true)
    }

    fn kept_unheld(&self, hold: &KeyHold<'_, SessionId>, run_id: RunId) -> Vec<QueueItemId> {
        let live_process = self.shared.deps.processes.process_identity(hold.key());
        let state = self.lock_state();
        state
            .continued_of(run_id, true)
            .into_iter()
            .filter(|item_id| {
                state
                    .hand_of(item_id)
                    .is_some_and(|handed| !is_kept_by_process(handed, live_process))
            })
            .collect()
    }

    fn settle_kept(
        &self,
        _hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
        settled: &[QueueItemId],
        taken: &[QueueItemId],
    ) -> BoxFuture<'_, Result<(), ContinuedMessagesError>> {
        let settled = settled.to_vec();
        let taken = taken.to_vec();
        Box::pin(async move { Ok(self.settle_kept_continue(run_id, &settled, &taken).await?) })
    }

    fn fail_kept(
        &self,
        _hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
        message_ids: &[QueueItemId],
    ) -> BoxFuture<'_, Result<(), ContinuedMessagesError>> {
        let message_ids = message_ids.to_vec();
        Box::pin(async move { Ok(self.fail_kept_continue(run_id, &message_ids).await?) })
    }
}
