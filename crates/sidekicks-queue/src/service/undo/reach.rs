//! What an undo to one of the person's messages reaches: the checkpoint it goes back to, which is
//! the pressed message's own, or, where the provider's conversation cut lands only at turns and
//! the conversation is in scope, the one the start of the turn a steer joined wrote, found through
//! that turn; what opened that turn; and the person's messages it takes back, read from the
//! daemon's own queue items in send order.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use rusqlite::{Connection, OptionalExtension as _, named_params};
use sidekicks_contracts::artifacts::attachment_reference::AttachmentReferenceList;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{MessageContent, QueueItemId};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::controls::methods::SessionReviewTarget;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::restore::{
    SessionRestoreResend, SessionRestoreScope, SessionRestoreTarget,
};
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::driver::contract::ProviderDriver;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_session::checkpoints::store::Checkpoint;
use sidekicks_session::checkpoints::store::kept::{
    CheckpointReadError, checkpoints_of_runs_from, read_checkpoint, turn_start_checkpoint,
};
use sidekicks_session::driver_resolution::resolve_live_run_driver;
use sidekicks_session::queue_store::{QueueItemBody, QueueItemReader, QueueMessageBody};
use sidekicks_session::run::read::read_run_provider;
use sidekicks_session::run::superseded::SupersededTurnsReadError;
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::database::stored_column::{safe_int_column, text_column};
use sidekicks_store::events::session::read::{
    DamagedFromSequenceReader, SessionEventReads, readable_event_sql, session_read_bound,
};

use super::ConversationCutError;
use crate::error::QueueError;
use crate::service::RunQueue;

// The session's lead runs made after `@run_id` that have left `queued`, oldest first: a run id is
// a UUIDv7, so the ids' order is the order the runs were made.
static LATER_LEAD_RUNS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT run_id FROM runs
  WHERE session_id = @session_id
    AND parent_run_id IS NULL
    AND state <> '{}'
    AND run_id > @run_id
  ORDER BY run_id",
        <&'static str>::from(RunState::Queued)
    )
});

// The number of the turn of `@run_id` the message `@message_id` last steered into; none when it
// steered no turn.
static STEERED_TURN_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT json_extract(steer.payload, '$.turnNumber') FROM session_events AS steer
  WHERE steer.session_id = @session_id AND steer.run_id = @run_id AND steer.type = '{}'
    AND {}
    AND json_extract(steer.payload, '$.messageId') = @message_id
  ORDER BY steer.sequence DESC
  LIMIT 1",
        SessionEventType::AgentTurnSteered.as_str(),
        readable_event_sql("steer"),
    )
});

/// What an undo to one of the person's messages goes back to, read before anything is stopped:
/// the preview and the conversation cut read it alike.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UndoReach {
    /// The checkpoint the undo goes back to, conversation and files together: the pressed
    /// message's own, or, with the conversation in scope on a provider whose cut lands only at
    /// turns, the one the start of the turn the pressed message steered into wrote.
    pub checkpoint: Checkpoint,
    /// The queue item the provider's cut is asked before: the person's message at `checkpoint`,
    /// or, where a turn no queue item opened stands there, the pressed steer, which a provider
    /// whose cut lands only at turns cuts before its turn.
    pub message_id: QueueItemId,
    /// The queue item of the message the person pressed.
    pub pressed_message_id: QueueItemId,
    /// What opened the turn the undo goes back to the start of, which the ask names; `None` where
    /// the undo goes back to the pressed message itself.
    pub opening: Option<TurnOpening>,
    /// Each of the person's messages the undo takes back, from `checkpoint` on, in send order:
    /// what goes back into the draft. A review or a plan's message is the daemon's and is not
    /// among them.
    pub cut_messages: Vec<CutMessage>,
}

/// What opened the turn an undo to a steer goes back to the start of.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TurnOpening {
    /// A queue item opened it: a message of its own, one an earlier turn already sent, as a
    /// retry turn carries, or a review.
    Queued {
        /// The queue item.
        queue_item_id: QueueItemId,
        /// What it carried, which its transcript row shows.
        kind: QueuedOpeningKind,
    },
    /// No queue item opened it: the provider began it, as Codex's answer to a question.
    Unqueued,
}

/// What the queue item that opened a turn carried.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum QueuedOpeningKind {
    /// The person's message, with its words.
    Message(MessageContent),
    /// The provider's review of `target`, which the person runs again from its own control.
    Review(SessionReviewTarget),
    /// A plan's message, with the words it opened its run with; the person runs it again from
    /// its own control.
    PlanMessage(MessageContent),
}

impl QueuedOpeningKind {
    fn of(body: &QueueItemBody) -> Self {
        match body {
            QueueItemBody::Message(message) => Self::Message(message.content.clone()),
            QueueItemBody::Review { target } => Self::Review(*target),
            QueueItemBody::PlanMessage { text, .. } => Self::PlanMessage(text.clone()),
        }
    }
}

/// One of the person's messages an undo takes back.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CutMessage {
    /// Its queue item.
    pub queue_item_id: QueueItemId,
    /// What it carried, as its queue item holds it.
    pub body: QueueMessageBody,
    /// Whether a resend of an edit of the pressed message carries it: the pressed message, and,
    /// where the undo goes back to the start of the pressed message's turn, every message of the
    /// person's in that turn.
    pub is_resent: bool,
}

impl UndoReach {
    /// Whether the undo goes back to the pressed message itself; where it does not, the ask names
    /// the turn's [`TurnOpening`].
    pub fn is_pressed_message(&self) -> bool {
        self.opening.is_none()
    }

    /// The one message a resend of `edited`, the pressed message's edit, sends as the new turn:
    /// `edited` alone where the undo goes back to the pressed message, else each of the person's
    /// messages of its turn the undo takes back, in send order with the edit in the pressed one's
    /// place, so a review, a plan's message or a retried message that opened the turn is left out
    /// for the person to run again from its own control: their words joined by a blank line, their
    /// files in the same order, each skill picked once in the order first picked, and the turn
    /// speed of the first of them, the opening's where the person sent it.
    pub fn resend_with(&self, edited: SessionRestoreResend) -> SessionRestoreResend {
        if self.is_pressed_message() {
            return edited;
        }
        let mut words = Vec::new();
        let mut attachments = Vec::new();
        let mut skills = Vec::new();
        let mut output_speed_for_turn = None;
        for message in self.cut_messages.iter().filter(|message| message.is_resent) {
            let (content, files, picks, speed) = if message.queue_item_id == self.pressed_message_id
            {
                (
                    &edited.content,
                    edited.attachments.as_ref().map(|files| files.0.as_slice()),
                    edited.skills.as_deref(),
                    edited.output_speed_for_turn.as_ref(),
                )
            } else {
                let body = &message.body;
                (
                    &body.content,
                    body.attachments.as_ref().map(|files| files.0.as_slice()),
                    body.skill_picks.as_deref(),
                    body.output_speed_for_turn.as_ref(),
                )
            };
            words.push(content.as_str());
            attachments.extend(files.unwrap_or_default().iter().copied());
            for pick in picks.unwrap_or_default() {
                if !skills.contains(pick) {
                    skills.push(pick.clone());
                }
            }
            if words.len() == 1 {
                output_speed_for_turn = speed.cloned();
            }
        }
        SessionRestoreResend {
            content: FreeFormText::new(words.join("\n\n"))
                .expect("free-form words joined by a blank line stay free-form text"),
            attachments: (!attachments.is_empty()).then_some(AttachmentReferenceList(attachments)),
            skills: (!skills.is_empty()).then_some(skills),
            output_speed_for_turn,
        }
    }
}

/// An undo's reach with what the cut reads beside it.
pub(super) struct ReachRead {
    /// The reach.
    pub(super) reach: UndoReach,
    /// The session's lead runs after the reach's run, oldest first; the cut takes each whole.
    pub(super) later_run_ids: Vec<RunId>,
    /// The driver of the reach's run, resolved when the conversation is in scope.
    pub(super) driver: Option<Arc<dyn ProviderDriver>>,
}

// What the log holds at a checkpoint's sequence.
enum CheckpointEvent {
    // One of the person's messages, with its queue item where it was sent through the queue.
    Sent(Option<QueueItemId>),
    // The start of a turn no new message of the person's opened.
    TurnStart,
}

impl RunQueue {
    /// What an undo of `session_id` to `target` at `scope` goes back to, as its cut reads it, for
    /// the ask before the press. Fails as the cut's reach fails: [`ConversationCutError`]'s
    /// `NoCheckpoint`, `Superseded`, `Rollback` and `MessageNotQueued`, or a read's failure.
    pub async fn read_undo_reach(
        &self,
        session_id: SessionId,
        target: &SessionRestoreTarget,
        scope: SessionRestoreScope,
    ) -> Result<UndoReach, ConversationCutError> {
        let target = target.clone();
        let providers = Arc::clone(&self.providers);
        let read_damaged_from_sequence = Arc::clone(&self.read_damaged_from_sequence);
        self.pool
            .read(ReadLength::Short, move |reader| {
                read_reach(
                    reader,
                    &providers,
                    &*read_damaged_from_sequence,
                    session_id,
                    &target,
                    scope,
                )
                .map(|read| read.reach)
            })
            .await
    }
}

/// Reads an undo's reach on `reader`, as [`RunQueue::read_undo_reach`] says.
pub(super) fn read_reach(
    reader: &Connection,
    providers: &ProviderRegistry,
    read_damaged: &DamagedFromSequenceReader,
    session_id: SessionId,
    target: &SessionRestoreTarget,
    scope: SessionRestoreScope,
) -> Result<ReachRead, ConversationCutError> {
    let pressed = match read_checkpoint(reader, read_damaged, session_id, target) {
        Ok(Some(stored)) => stored.checkpoint,
        Ok(None) => return Err(ConversationCutError::NoCheckpoint { source: None }),
        Err(CheckpointReadError::CursorUnresolvable(source)) => {
            return Err(ConversationCutError::NoCheckpoint {
                source: Some(source),
            });
        }
        Err(CheckpointReadError::Superseded { .. }) => {
            return Err(ConversationCutError::Superseded);
        }
        Err(CheckpointReadError::Database(error)) => return Err(QueueError::from(error).into()),
        Err(CheckpointReadError::Rollback(error)) => {
            return Err(ConversationCutError::Rollback(error));
        }
    };
    let run_id = pressed.run_id;
    let later_run_ids = reader
        .prepare_cached(&LATER_LEAD_RUNS_SQL)
        .and_then(|mut statement| {
            statement
                .query_map(
                    named_params! {
                        "@session_id": session_id.text().as_str(),
                        "@run_id": run_id.text().as_str(),
                    },
                    |row| text_column(row, 0, |text| RunId::new(&text)),
                )?
                .collect::<rusqlite::Result<Vec<RunId>>>()
        })
        .map_err(QueueError::from)?;
    let driver = match scope {
        SessionRestoreScope::ConversationAndFiles | SessionRestoreScope::Conversation => {
            let bound = read_run_provider(reader, &run_id)
                .map_err(QueueError::from)?
                .map(|bound| bound.provider);
            Some(resolve_live_run_driver(providers, run_id, bound).map_err(QueueError::from)?)
        }
        SessionRestoreScope::Files => None,
    };
    let cuts_only_at_turns = driver
        .as_ref()
        .is_some_and(|driver| !driver.can_cut_inside_turn());
    let events = SessionEventReads::new(reader, read_damaged);
    let read_events = |checkpoints: &[&Checkpoint]| -> Result<_, ConversationCutError> {
        let sequences: Vec<i64> = checkpoints
            .iter()
            .map(|checkpoint| i64::from(checkpoint.message_sequence))
            .collect();
        let mut at_sequence = HashMap::with_capacity(sequences.len());
        for envelope in events
            .read_at_sequences(&session_id, &sequences)
            .map_err(QueueError::from)?
        {
            let sequence = i64::from(envelope.sequence);
            // A checkpoint stands before one of the person's messages or a turn's start.
            let event = SessionEvent::from_envelope(&envelope).map_err(QueueError::from)?;
            if let SessionEvent::AgentTurnStarted(_) = event {
                at_sequence.insert(sequence, CheckpointEvent::TurnStart);
            } else if let SessionEvent::UserMessageSent(payload) = event {
                at_sequence.insert(sequence, CheckpointEvent::Sent(payload.queue_item_id));
            }
        }
        Ok(at_sequence)
    };
    let pressed_message_id =
        match read_events(&[&pressed])?.remove(&i64::from(pressed.message_sequence)) {
            Some(CheckpointEvent::Sent(Some(queue_item_id))) => queue_item_id,
            Some(CheckpointEvent::Sent(None) | CheckpointEvent::TurnStart) | None => {
                return Err(ConversationCutError::MessageNotQueued);
            }
        };
    // The start of the turn the pressed message steered into, where the undo goes back to it.
    let steered_turn_start = if cuts_only_at_turns {
        let steered_turn = reader
            .prepare_cached(&STEERED_TURN_SQL)
            .and_then(|mut statement| {
                statement
                    .query_row(
                        named_params! {
                            "@session_id": session_id.text().as_str(),
                            "@run_id": run_id.text().as_str(),
                            "@message_id": pressed_message_id.to_string(),
                            "@read_bound": session_read_bound(read_damaged, &session_id, None),
                        },
                        |row| safe_int_column::<1>(row, 0),
                    )
                    .optional()
            })
            .map_err(QueueError::from)?;
        match steered_turn {
            Some(turn_number) => {
                let start = turn_start_checkpoint(reader, session_id, run_id, turn_number)
                    .map_err(QueueError::from)?
                    .filter(|start| start.checkpoint.checkpoint_id != pressed.checkpoint_id)
                    .ok_or(ConversationCutError::MessageNotQueued)?;
                Some(start)
            }
            None => None,
        }
    } else {
        None
    };
    let turn_opening_id = steered_turn_start
        .as_ref()
        .and_then(|start| start.turn_opening_id);
    let checkpoint = steered_turn_start.map_or_else(|| pressed.clone(), |start| start.checkpoint);
    let reached_runs: Vec<RunId> = std::iter::once(run_id)
        .chain(later_run_ids.iter().copied())
        .collect();
    let reached = match checkpoints_of_runs_from(
        reader,
        read_damaged,
        session_id,
        &reached_runs,
        checkpoint.message_sequence,
    ) {
        Ok(reached) => reached,
        Err(SupersededTurnsReadError::Database(error)) => {
            return Err(QueueError::from(error).into());
        }
        Err(SupersededTurnsReadError::Rollback(error)) => {
            return Err(ConversationCutError::Rollback(error));
        }
    };
    let reached: Vec<&Checkpoint> = reached.iter().map(|stored| &stored.checkpoint).collect();
    let at_sequence = read_events(&reached)?;
    let is_turn_reach = checkpoint.checkpoint_id != pressed.checkpoint_id;
    let is_resent = |cut: &Checkpoint| {
        if is_turn_reach {
            cut.run_id == run_id && cut.turn_number == pressed.turn_number
        } else {
            cut.checkpoint_id == pressed.checkpoint_id
        }
    };
    let items = QueueItemReader::new(reader);
    let read_body = |queue_item_id: QueueItemId| -> Result<QueueItemBody, ConversationCutError> {
        Ok(items
            .get(&queue_item_id)
            .map_err(QueueError::from)?
            .ok_or(ConversationCutError::MessageNotQueued)?
            .body)
    };
    let mut opening = None;
    let mut is_opened_by_its_row = false;
    let mut cut_messages = Vec::new();
    for cut in reached {
        let is_reach = is_turn_reach && cut.checkpoint_id == checkpoint.checkpoint_id;
        let queue_item_id = match at_sequence.get(&i64::from(cut.message_sequence)) {
            Some(CheckpointEvent::Sent(Some(queue_item_id))) => *queue_item_id,
            Some(CheckpointEvent::TurnStart) => {
                if is_reach {
                    opening = Some(match turn_opening_id {
                        Some(queue_item_id) => TurnOpening::Queued {
                            queue_item_id,
                            kind: QueuedOpeningKind::of(&read_body(queue_item_id)?),
                        },
                        None => TurnOpening::Unqueued,
                    });
                }
                continue;
            }
            Some(CheckpointEvent::Sent(None)) | None => {
                return Err(ConversationCutError::MessageNotQueued);
            }
        };
        let body = read_body(queue_item_id)?;
        if is_reach {
            is_opened_by_its_row = true;
            opening = Some(TurnOpening::Queued {
                queue_item_id,
                kind: QueuedOpeningKind::of(&body),
            });
        }
        // A review or a plan's message is the daemon's, not the person's words.
        if let QueueItemBody::Message(body) = body {
            cut_messages.push(CutMessage {
                queue_item_id,
                body,
                is_resent: is_resent(cut),
            });
        }
    }
    // A turn whose start stands at a row of its own is cut before through the pressed steer,
    // which a provider whose cut lands only at turns cuts before its turn.
    let message_id = match &opening {
        Some(TurnOpening::Queued { queue_item_id, .. }) if is_opened_by_its_row => *queue_item_id,
        Some(TurnOpening::Queued { .. } | TurnOpening::Unqueued) | None => pressed_message_id,
    };
    Ok(ReachRead {
        reach: UndoReach {
            checkpoint,
            message_id,
            pressed_message_id,
            opening,
            cut_messages,
        },
        later_run_ids,
        driver,
    })
}
