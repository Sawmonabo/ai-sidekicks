//! The release of an undo's hold on a session's lead: the edited message sent under the undo's
//! key ahead of every send held meanwhile, the lead's next turn opened once, and each run whose
//! resume the session's undos held back resumed.

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{AgentQueueItemCreateRequest, QueueItemId, QueueItemState};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::restore::SessionRestoreResend;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_session::checkpoints::resends::is_resend_returned;
use sidekicks_session::queue_store::{QueueItemRecord, placement_statements};
use sidekicks_session::run::read::read_run_through;
use sidekicks_std::keyed_lock::KeyHold;
use sidekicks_store::database::connection::read_pool::ReadLength;

use super::UndoHold;
use crate::delivery::{UndoHoldId, reordered_of};
use crate::error::QueueError;
use crate::service::RunQueue;

impl RunQueue {
    /// Lets go the undo's `hold`. With `resend`, the edited message is first sent from `device_id`
    /// as any send is, under the undo's key, so a repeated undo sends it once, and placed ahead of
    /// every lead message waiting for its run; a key whose edited message a start put back into the
    /// draft sends nothing, the draft holding the words. Once the session's last undo lets go, the
    /// lead's next turn is opened once, as a send would open it, for the run its first waiting
    /// message waits for: the resend, then the sends held meanwhile in the order they were
    /// recorded. A run that reads its opening later (a queued or interrupted run's start, a paused
    /// one's resume) has the resend reserved as that opening, so no reorder or `Send now` meanwhile
    /// puts another message ahead of it; a resume that does not go drops the reservation while it
    /// still names this resend. Then each run whose resume the session's undos held back is resumed
    /// once, in the order the resumes came, at its version read then, while it is still pausing or
    /// paused; one the undo moved on is dropped. The hold is let go and the turn opened whatever
    /// the resend answered, on a task of the queue's own, so a caller that goes away meanwhile
    /// still lets it go; fails afterwards with the first failure, the resend's first.
    pub async fn release_undo_hold(
        &self,
        hold: UndoHold,
        resend: Option<SessionRestoreResend>,
        device_id: DeviceId,
    ) -> Result<(), QueueError> {
        let (session_id, undo_key, hold_id) = hold.take();
        let queue = self
            .this
            .upgrade()
            .expect("the queue lives while a call of it runs");
        let released = self.releases.spawn(async move {
            queue
                .let_go_undo_hold(
                    session_id,
                    undo_key,
                    hold_id,
                    resend.map(|resend| (resend, device_id)),
                )
                .await
        });
        match released.await {
            Ok(released) => released,
            // The tracker never aborts its tasks, and the runtime's shutdown drops this call with
            // them, so only a panic ends one early.
            Err(error) => std::panic::resume_unwind(error.into_panic()),
        }
    }

    // Lets go the hold `hold_id` the undo `undo_key` took on `session_id` as `release_undo_hold`
    // says, with `resend` sent from its device first under that key, unless a start put the key's
    // edited message back into the draft, which then holds the words and nothing is sent.
    pub(super) async fn let_go_undo_hold(
        &self,
        session_id: SessionId,
        undo_key: ClientUuid,
        hold_id: UndoHoldId,
        resend: Option<(SessionRestoreResend, DeviceId)>,
    ) -> Result<(), QueueError> {
        let mut first_failure = None;
        let resend = match resend {
            Some(resend) => {
                let key = undo_key.clone();
                match self
                    .pool
                    .read(ReadLength::Short, move |reader| {
                        Ok::<_, QueueError>(is_resend_returned(reader, session_id, &key)?)
                    })
                    .await
                {
                    Ok(false) => Some(resend),
                    Ok(true) => None,
                    Err(error) => {
                        first_failure = Some(error);
                        None
                    }
                }
            }
            None => None,
        };
        if let Some((resend, device_id)) = resend {
            let request = AgentQueueItemCreateRequest {
                session_id,
                to: None,
                workspace_id: None,
                client_idempotency_key: undo_key.clone(),
                content: resend.content,
                attachments: resend.attachments,
                skills: resend.skills,
                replaces_queue_item_id: None,
                answers_question_id: None,
                output_speed_for_turn: resend.output_speed_for_turn,
            };
            if let Err(error) = self.create(request, device_id).await {
                first_failure = Some(error);
            }
        }
        let (opened, owed_resumes) = {
            let queue_hold = self.session_lock.hold_session(session_id).await;
            let mut resent = None;
            if first_failure.is_none() {
                match self.place_resend_first(session_id, &undo_key).await {
                    Ok(placed) => resent = placed,
                    Err(error) => first_failure = Some(error),
                }
            }
            match self.delivery.release_undo_hold(session_id, hold_id) {
                Some(owed_resumes) => match self.open_after_undo(&queue_hold, resent).await {
                    Ok(opened) => (opened, owed_resumes),
                    Err(error) => {
                        first_failure.get_or_insert(error);
                        (None, owed_resumes)
                    }
                },
                None => (None, Vec::new()),
            }
        };
        let opened_run_id = opened.map(|(run_id, _, _)| run_id);
        if let Some((run_id, run_version, reserved_id)) = opened {
            #[cfg(test)]
            self.resume_pause.pass().await;
            if !self.resume_paused_run(run_id, run_version).await
                && let Some(reserved_id) = reserved_id
            {
                self.admission.drop_reservation_naming(run_id, reserved_id);
            }
        }
        // The run the opening resumed is not resumed again.
        for run_id in owed_resumes {
            if Some(run_id) == opened_run_id {
                continue;
            }
            match read_run_through::<QueueError>(&self.pool, run_id).await {
                Ok(Some(run)) if matches!(run.state, RunState::Pausing | RunState::Paused) => {
                    // A resume that did not go was logged, and the run's messages wait.
                    let _resumed = self.resume_paused_run(run_id, run.version).await;
                }
                // The undo interrupted the run or it ended: its waiting messages go as it moves.
                Ok(_) => {}
                Err(error) => {
                    first_failure.get_or_insert(error);
                }
            }
        }
        first_failure.map_or(Ok(()), Err)
    }

    // Puts the message sent under `undo_key` first among the unhanded lead messages waiting for
    // its run, in one write, and answers it; one no longer waiting or handed, a repeated undo's,
    // stays where it is and is answered `None`. Called under the session's queue lock.
    async fn place_resend_first(
        &self,
        session_id: SessionId,
        undo_key: &ClientUuid,
    ) -> Result<Option<QueueItemRecord>, QueueError> {
        let Some(resent) = self.read_saved(session_id, undo_key).await? else {
            return Ok(None);
        };
        let Some(run_id) = resent.target_run_id else {
            return Ok(None);
        };
        let waiting: Vec<_> = self
            .read_waiting(run_id)
            .await?
            .into_iter()
            .filter(|item| item.child_handle.is_none() && !self.delivery.is_handed(&item.id))
            .collect();
        let Some(ordered) = reordered_of(&waiting, Some(resent.id)) else {
            return Ok(None);
        };
        self.writer
            .write(placement_statements(&ordered, &WireInstant::now()))
            .await?;
        self.recorder.raise_committed(&ordered, true);
        Ok(Some(resent))
    }

    // Opens the lead's next turn as a send would, for the run the first lead message waiting in
    // the session waits for: handed into a live run, a continue of an interrupted one, a start of
    // a queued one; a paused or pausing one is answered with its version and the item reserved
    // for it, to resume once the session's lock is let go. `resent`, when that run's, is
    // reserved as the opening of every run but a live one, which hands it first in the queue's
    // order. Called under `hold`.
    async fn open_after_undo(
        &self,
        hold: &KeyHold<'_, SessionId>,
        resent: Option<QueueItemRecord>,
    ) -> Result<Option<(RunId, i64, Option<QueueItemId>)>, QueueError> {
        let session_id = *hold.key();
        let first = self
            .read_queue(session_id, None, Some(QueueItemState::Queued))
            .await?
            .into_iter()
            .next();
        let Some((item, run_id)) =
            first.and_then(|item| item.target_run_id.map(|run_id| (item, run_id)))
        else {
            return Ok(None);
        };
        let Some(run) = read_run_through::<QueueError>(&self.pool, run_id).await? else {
            return Ok(None);
        };
        let does_read_opening_later = matches!(
            run.state,
            RunState::Queued | RunState::Interrupted | RunState::Pausing | RunState::Paused
        );
        let reserved_id = resent
            .filter(|resent| does_read_opening_later && resent.target_run_id == Some(run_id))
            .map(|resent| resent.id);
        if let Some(reserved_id) = reserved_id {
            self.admission.reserve_opening(run_id, reserved_id);
        }
        match run.state {
            RunState::Queued => self.admission.start(session_id, run_id),
            RunState::Interrupted => {
                self.lifecycle
                    .continue_interrupted_run(hold, run_id, true)
                    .await?;
                // A run left resting, with no continue under way, would keep the reservation.
                if let Some(reserved_id) = reserved_id
                    && !self.admission.is_starting(run_id)
                {
                    self.admission.drop_reservation_naming(run_id, reserved_id);
                }
            }
            RunState::Starting
            | RunState::Running
            | RunState::WaitingForApproval
            | RunState::WaitingForInput => {
                self.delivery.accept_send(hold, &item, run_id).await?;
            }
            RunState::Pausing | RunState::Paused => {
                self.delivery.accept_send(hold, &item, run_id).await?;
                return Ok(Some((run_id, run.version, reserved_id)));
            }
            // A message waiting for an ended run moves on with that run's end.
            RunState::Completed | RunState::Stopped | RunState::Failed => {}
        }
        Ok(None)
    }
}
