//! The messages a paused run's resume delivers, never a review or a plan message: read and marked
//! handed under the session lock, admitted once the driver continued the run, given back when it
//! did not, and kept when the resume went out with no answer back. A kept message is read by no
//! later continue and stays handed past the run's end, until the provider shows it took it or its
//! own record says what became of it, which is final only once no live provider process still holds
//! it. After the daemon's restart, when no hand is remembered, a resumed run's record settles the
//! waiting messages the same way: one it holds admitted, and when it is unreadable every one ended
//! not delivered in the run's own write, or alone where the run is left as it is. An item an
//! undo's release reserved as the run's opening goes first; while an undo holds the session the
//! read answers held, reading nothing, and the run is owed a resume at the undo's release. A paused
//! run continued in a session no process of this daemon holds since its restart has the session
//! opened first, as its first admission would. A paused run continued while the restart still
//! holds its session's lead, a helper beneath it or the lead itself, keeps its messages for the
//! lead's continue, which carries them as that run's words and has them delivered with it once the
//! provider took it.

use std::collections::HashMap;
use std::error::Error;

use futures::future::BoxFuture;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_provider::driver::attachments::{compose_message_text, resolve_message_attachments};
use sidekicks_provider::driver::message_handing::MessageHanding;
use sidekicks_provider::driver::run_control::WaitingMessage;
use sidekicks_provider::port::run_pause::{
    ContinuedMessages, ContinuedMessagesError, ContinuedRead, SessionOpening,
};
use sidekicks_session::queue_store::{QueueItemRecord, RecordedQueueItemState};
use sidekicks_session::run::state_change::RunWriteCompanions;
use sidekicks_std::keyed_lock::KeyHold;

use crate::delivery::run_end::not_delivered_ends;
use crate::delivery::state::{HandRoute, HandedMessage, is_kept_by_process};
use crate::delivery::{DeliveryError, QueueDelivery, reordered_of};
use crate::provider_session::held_run_continue::{KeptMessages, KeptWords};
use crate::recorder::QueueRecordError;

impl QueueDelivery {
    // The unhanded lead messages waiting for `run_id` of `session_id`, a continue that did not go
    // read again (one a resume keeps excepted), each marked handed by the continue to a provider
    // that takes messages as `handing` says, in the queue's order, the item an undo's release
    // reserved first. Under an undo's hold it answers held, nothing read, the reservation left
    // for the release's own resume and the run owed a resume at the release. Called under the
    // session's queue lock, which the hold is set under.
    async fn read_continued(
        &self,
        session_id: SessionId,
        run_id: RunId,
        handing: MessageHanding,
    ) -> Result<ContinuedRead, DeliveryError> {
        if self.lock_state().owe_resume_after_undo(session_id, run_id) {
            return Ok(ContinuedRead::HeldForUndo);
        }
        // Taken before the read, which leaves a reserved item out as an opening.
        let reserved = self.shared.deps.openings.take_reserved(run_id);
        let waiting = self.lead_messages(self.read_waiting(run_id).await?);
        let lead_waiting = reordered_of(&waiting, reserved).unwrap_or(waiting);
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
        Ok(ContinuedRead::Messages(
            items
                .iter()
                .map(|item| {
                    let message = item.body.as_message().expect(
                        "a continue gathers only messages, never a review or a plan message",
                    );
                    WaitingMessage {
                        id: item.id,
                        attachments: message.attachment_ids(),
                        skills: message.skills.clone().unwrap_or_default(),
                        content: message.content.clone(),
                    }
                })
                .collect(),
        ))
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
            if taken.contains(&item_id) {
                self.admit_taken(item_id, run_id).await?;
            } else {
                self.forget_hand(item_id);
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
            self.fail_waiting(item_id).await?;
        }
        Ok(())
    }

    /// The words the messages continues kept in `session_id` while no provider process held it
    /// make, by the run each was kept for, with their ids, as a held lead's continue carries them.
    /// Fails as a read or the files' lookup fails.
    pub(crate) async fn kept_words(
        &self,
        session_id: SessionId,
    ) -> Result<HashMap<RunId, KeptWords>, Box<dyn Error + Send + Sync>> {
        // A hand an unanswered resume kept while a process ran may be taken already, so its
        // provider's record settles it instead.
        let kept: Vec<(QueueItemId, RunId)> = self
            .lock_state()
            .hands()
            .filter(|(_, handed)| is_kept_without_process(handed))
            .map(|(item_id, handed)| (*item_id, handed.run_id))
            .collect();
        let mut by_run: HashMap<RunId, Vec<QueueItemRecord>> = HashMap::new();
        for (item_id, run_id) in kept {
            if let Some(item) = self.read_item(item_id).await?
                && item.session_id == session_id
                && item.state == RecordedQueueItemState::Queued
            {
                by_run.entry(run_id).or_default().push(item);
            }
        }
        let attachments = &*self.shared.deps.attachments;
        let mut words = HashMap::new();
        for (run_id, mut items) in by_run {
            items.sort_by_key(|item| item.position);
            // Each message's words then a line naming each file's path, joined by a blank line.
            let mut texts = Vec::new();
            for item in &items {
                let Some(message) = item.body.as_message() else {
                    continue;
                };
                let files = resolve_message_attachments(
                    attachments,
                    &session_id,
                    &message.attachment_ids(),
                )
                .await?;
                texts.push(compose_message_text(message.content.as_str(), &files));
            }
            words.insert(
                run_id,
                KeptWords {
                    message_ids: items.iter().map(|item| item.id).collect(),
                    words: texts.join("\n\n"),
                },
            );
        }
        Ok(words)
    }

    /// Forgets the hands of the messages a continue of `run_id` kept while no provider process held
    /// its session, so the run's next continue reads them again. Called once a failed continue
    /// moved the run back to `paused`, under the session's queue lock.
    pub(crate) fn forget_kept_words(&self, run_id: RunId) {
        self.lock_state()
            .retain_hands(|handed| handed.run_id != run_id || !is_kept_without_process(handed));
    }

    /// Admits into `run_id` each of `taken` still waiting, the provider's own record of the run's
    /// conversation holding it after the daemon's restart, or a held lead's continue carrying it as
    /// a continued run's words, so no hand sends it again; one no longer waiting is left as it
    /// stands. Called by a resume's ingress for each lead run the resume named, and by a relaunch
    /// for each run whose words its continue carried, before the resumed binding is recorded,
    /// under the session's transition lock alone. Fails at the first read or record that fails,
    /// the admissions before it kept.
    pub async fn admit_taken_after_restart(
        &self,
        run_id: RunId,
        taken: &[QueueItemId],
    ) -> Result<(), DeliveryError> {
        for item_id in taken {
            self.admit_taken(*item_id, run_id).await?;
        }
        Ok(())
    }

    /// The messages still waiting for `run_id`, in the queue's order, with the companions that end
    /// each not delivered in the run's own write, for a resume whose provider record is unreadable.
    /// Called under the session's transition lock alone; fails as the read or an event draft fails.
    pub async fn read_unread_ends(
        &self,
        run_id: RunId,
    ) -> Result<(Vec<QueueItemRecord>, RunWriteCompanions), DeliveryError> {
        let waiting: Vec<QueueItemRecord> = self
            .read_waiting(run_id)
            .await?
            .into_iter()
            .filter(|item| item.body.as_message().is_some())
            .collect();
        let companions =
            not_delivered_ends(&waiting, &WireInstant::now()).map_err(QueueRecordError::from)?;
        Ok((waiting, companions))
    }

    /// Ends `items`, at least one, which [`QueueDelivery::read_unread_ends`] read, not delivered
    /// in one write of their own, for a resumed run whose finalize left it as it is and so wrote
    /// none of their ends, then forgets their hands and raises their queues. Fails as the write
    /// fails, refused when one of them has left `queued`; nothing is written then.
    pub async fn fail_unread_after_restart(
        &self,
        items: &[QueueItemRecord],
    ) -> Result<(), DeliveryError> {
        let ends =
            not_delivered_ends(items, &WireInstant::now()).map_err(QueueRecordError::from)?;
        self.shared.deps.recorder.record_ends(ends).await?;
        self.settle_ended(items);
        Ok(())
    }

    /// Whether a provider process of this daemon holds `session_id` now. A continue that failed
    /// leaves a lead such a process holds as the process has it.
    pub(crate) fn has_live_process(&self, session_id: SessionId) -> bool {
        self.shared
            .deps
            .processes
            .process_identity(&session_id)
            .is_some()
    }

    /// Forgets the hand of each of `items` and raises their queues, once a write that moved them
    /// out of `queued` committed: a resumed run's own write or
    /// [`QueueDelivery::fail_unread_after_restart`]'s.
    pub fn settle_ended(&self, items: &[QueueItemRecord]) {
        for item in items {
            self.forget_hand(item.id);
        }
        self.shared.deps.recorder.raise_committed(items, false);
    }

    // Admits `item_id` into `run_id` while it still waits, its provider having taken it; its
    // hand, if any, is forgotten either way.
    async fn admit_taken(&self, item_id: QueueItemId, run_id: RunId) -> Result<(), DeliveryError> {
        match self.read_item(item_id).await? {
            Some(item) if item.state == RecordedQueueItemState::Queued => {
                self.record_admission(&item, run_id).await
            }
            Some(_) | None => {
                self.forget_hand(item_id);
                Ok(())
            }
        }
    }

    // Ends `item_id` not delivered while it still waits; its hand, if any, is forgotten either
    // way.
    async fn fail_waiting(&self, item_id: QueueItemId) -> Result<(), DeliveryError> {
        match self.read_item(item_id).await? {
            Some(item) if item.state == RecordedQueueItemState::Queued => {
                let failed = self.record_failed(&item).await;
                self.forget_hand(item_id);
                failed
            }
            Some(_) | None => {
                self.forget_hand(item_id);
                Ok(())
            }
        }
    }
}

impl KeptMessages for QueueDelivery {
    fn deliver_carried(
        &self,
        run_id: RunId,
        message_ids: Vec<QueueItemId>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        Box::pin(async move { Ok(self.admit_taken_after_restart(run_id, &message_ids).await?) })
    }
}

// Whether `handed` is a message a continue kept while no provider process held its session: its
// words go with the held lead's continue.
fn is_kept_without_process(handed: &HandedMessage) -> bool {
    matches!(handed.route, HandRoute::Continue { is_kept: true, .. }) && handed.process.is_none()
}

// The provider sessions were dropped: the daemon is stopping, so no session opens.
#[derive(Debug, thiserror::Error)]
#[error("the daemon stopped before session {session_id} was opened")]
struct SessionsStopped {
    session_id: SessionId,
}

impl ContinuedMessages for QueueDelivery {
    fn open_session(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<SessionOpening, ContinuedMessagesError>> {
        Box::pin(async move {
            let sessions = self
                .shared
                .deps
                .provider_sessions
                .upgrade()
                .ok_or(SessionsStopped { session_id })?;
            let resumed = sessions.resume_after_restart(session_id).await?;
            Ok(if resumed.is_deferred {
                SessionOpening::Deferred
            } else {
                SessionOpening::Opened
            })
        })
    }

    fn continue_held_lead(&self, session_id: SessionId, helper_run_id: RunId) {
        self.shared
            .deps
            .held_lead_continuation
            .continue_held_lead(session_id, helper_run_id);
    }

    fn hold_session(&self, session_id: SessionId) -> BoxFuture<'_, KeyHold<'_, SessionId>> {
        Box::pin(self.shared.deps.session_lock.hold_session(session_id))
    }

    fn read(
        &self,
        hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
        handing: MessageHanding,
    ) -> BoxFuture<'_, Result<ContinuedRead, ContinuedMessagesError>> {
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
