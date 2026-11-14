//! What an undo to one of the person's messages reaches: the checkpoint it goes back to, which is
//! the pressed message's own, or, with the conversation in scope for a message whose landing names
//! the group the provider's cut takes it with, the group's first: the first message's own
//! checkpoint, or the one the start of the turn wrote where the group begins at the turn's
//! opening; what stands there; and the person's messages it takes back, read from the daemon's own
//! queue items in send order.

use std::collections::{HashMap, HashSet};
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
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::driver::contract::ProviderDriver;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_session::checkpoints::store::Checkpoint;
use sidekicks_session::checkpoints::store::kept::{
    CheckpointReadError, checkpoints_reached_from, read_checkpoint, sent_message_checkpoint,
    turn_start_checkpoint,
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

// The number of the turn of `@run_id` the message `@message_id` last steered into, with where the
// group the provider's cut takes it with begins, as that landing named it: its kind and, for a
// message, that message's queue item; none when it steered no turn.
static STEERED_TURN_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT json_extract(steer.payload, '$.turnNumber'),
    json_extract(steer.payload, '$.cutGroupStart.kind'),
    json_extract(steer.payload, '$.cutGroupStart.messageId')
  FROM session_events AS steer
  WHERE steer.session_id = @session_id AND steer.run_id = @run_id AND steer.type = '{}'
    AND {}
    AND json_extract(steer.payload, '$.messageId') = @message_id
  ORDER BY steer.sequence DESC
  LIMIT 1",
        SessionEventType::AgentTurnSteered.as_str(),
        readable_event_sql("steer"),
    )
});

// The queue items of the messages that landed in turn `@turn_number` of `@run_id` naming the group
// start of kind `@kind` at the queue item `@group_message_id` (empty for the turn's opening).
static GROUP_MEMBERS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT json_extract(steer.payload, '$.messageId')
  FROM session_events AS steer
  WHERE steer.session_id = @session_id AND steer.run_id = @run_id AND steer.type = '{}'
    AND {}
    AND json_extract(steer.payload, '$.turnNumber') = @turn_number
    AND json_extract(steer.payload, '$.cutGroupStart.kind') = @kind
    AND ifnull(json_extract(steer.payload, '$.cutGroupStart.messageId'), '') = @group_message_id",
        SessionEventType::AgentTurnSteered.as_str(),
        readable_event_sql("steer"),
    )
});

// Where the group the pressed message's landing named begins, in the turn it landed in.
enum GroupStart {
    // At whatever opened that turn.
    TurnOpening,
    // At this queue item's message.
    Message(QueueItemId),
}

impl GroupStart {
    // The group start's kind and message as its landing's payload spells them.
    fn stored(&self) -> (&'static str, String) {
        match self {
            Self::TurnOpening => ("turnOpening", String::new()),
            Self::Message(message_id) => ("message", message_id.to_string()),
        }
    }
}

/// What an undo to one of the person's messages goes back to, read before anything is stopped:
/// the preview and the conversation cut read it alike.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UndoReach {
    /// The checkpoint the undo goes back to, conversation and files together: the pressed
    /// message's own, or, with the conversation in scope for a message that landed in a group the
    /// provider's cut takes whole, the group's first message's own, or, for a group that begins
    /// at its turn's opening, the one the start of that turn wrote, or, for a turn that reopened a
    /// prompt an earlier turn sent, as a retry turn does, that prompt's own.
    pub checkpoint: Checkpoint,
    /// The queue item the provider's cut is asked before: the person's message at `checkpoint`,
    /// or, where a turn no queue item opened stands there, the pressed message, which the
    /// provider's cut takes with that turn's opening.
    pub message_id: QueueItemId,
    /// The queue item of the message the person pressed.
    pub pressed_message_id: QueueItemId,
    /// What opened the turn the undo goes back to the start of, which the ask names; `None` where
    /// the undo goes back to the pressed message itself.
    pub opening: Option<TurnOpening>,
    /// Each of the person's messages the undo takes back, in send order: those that landed in
    /// `checkpoint`'s run from its run position on, whenever sent, as the rollback cuts them, and
    /// those of the later runs sent from `checkpoint` on: what goes back into the draft. A review
    /// or a plan's message is the daemon's and is not among them.
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
    /// where the pressed message rode a group the provider's cut takes whole, the first of it or
    /// not, the person's message at `checkpoint` and every other member of that group.
    pub is_resent: bool,
}

impl UndoReach {
    /// Whether the undo goes back to the pressed message itself; where it does not, the ask names
    /// the turn's [`TurnOpening`].
    pub fn is_pressed_message(&self) -> bool {
        self.opening.is_none()
    }

    /// The person's messages that undo together with the pressed one because they reached the
    /// provider together, in send order, which the dry run names for the ask to count, the pressed
    /// one among them whichever member of its group it is; empty where no other message undoes
    /// with it.
    pub fn undone_together(&self) -> Vec<QueueItemId> {
        let together: Vec<QueueItemId> = self
            .cut_messages
            .iter()
            .filter(|message| message.is_resent)
            .map(|message| message.queue_item_id)
            .collect();
        if together.len() < 2 {
            return Vec::new();
        }
        together
    }

    /// The one message a resend of `edited`, the pressed message's edit, sends as the new turn:
    /// `edited` alone where no other message is resent with the pressed one, else each of the
    /// person's messages of its group the undo takes back, with a prompt the turn reopened, in
    /// send order with the edit in the pressed one's place, so a review or a plan's message that
    /// opened the turn is left out for the person to run again from its own control: their words
    /// joined by a blank line, their files in the same order, each skill picked once in the order
    /// first picked, and the turn speed of the first of them, the opening's where the person sent
    /// it.
    pub fn resend_with(&self, edited: SessionRestoreResend) -> SessionRestoreResend {
        let is_resent_alone = self
            .cut_messages
            .iter()
            .all(|message| !message.is_resent || message.queue_item_id == self.pressed_message_id);
        if is_resent_alone {
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
    // Where the group the provider's cut takes the pressed message with begins, in the turn it
    // landed in, which the conversation's undo goes back to the start of; the files alone are
    // exact.
    let group = if driver.is_some() {
        reader
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
                        |row| {
                            let turn_number = safe_int_column::<1>(row, 0)?;
                            let start = match row.get::<_, Option<String>>(1)?.as_deref() {
                                Some("turnOpening") => Some(GroupStart::TurnOpening),
                                Some("message") => {
                                    Some(GroupStart::Message(text_column(row, 2, |text| {
                                        QueueItemId::new(&text)
                                    })?))
                                }
                                Some(_) | None => None,
                            };
                            Ok(start.map(|start| (turn_number, start)))
                        },
                    )
                    .optional()
            })
            .map_err(QueueError::from)?
            .flatten()
    } else {
        None
    };
    let reach_start = match &group {
        // A start row naming a prompt an earlier turn of the run already sent, as a retry turn's
        // does, gives way to that prompt's own checkpoint: the provider's cut before the opening
        // drops it from the conversation, so the rollback, the draft and the resend take it back
        // too.
        Some((turn_number, GroupStart::TurnOpening)) => {
            let start = turn_start_checkpoint(reader, session_id, run_id, *turn_number)
                .map_err(QueueError::from)?
                .filter(|start| start.checkpoint.checkpoint_id != pressed.checkpoint_id)
                .ok_or(ConversationCutError::MessageNotQueued)?;
            Some(match start.turn_opening_id {
                Some(opening) => sent_message_checkpoint(reader, read_damaged, session_id, opening)
                    .map_err(cut_error_of)?
                    .filter(|sent| sent.checkpoint.run_id == run_id)
                    .unwrap_or(start),
                None => start,
            })
        }
        Some((_, GroupStart::Message(first))) => Some(
            sent_message_checkpoint(reader, read_damaged, session_id, *first)
                .map_err(cut_error_of)?
                .filter(|sent| sent.checkpoint.run_id == run_id)
                .ok_or(ConversationCutError::MessageNotQueued)?,
        ),
        None => None,
    };
    let turn_opening_id = reach_start.as_ref().and_then(|start| start.turn_opening_id);
    let checkpoint = reach_start.map_or_else(|| pressed.clone(), |start| start.checkpoint);
    let group_members = |turn_number: SafeInt<1>, start: &GroupStart| {
        let (kind, group_message_id) = start.stored();
        reader
            .prepare_cached(&GROUP_MEMBERS_SQL)
            .and_then(|mut statement| {
                statement
                    .query_map(
                        named_params! {
                            "@session_id": session_id.text().as_str(),
                            "@run_id": run_id.text().as_str(),
                            "@turn_number": i64::from(turn_number),
                            "@kind": kind,
                            "@group_message_id": group_message_id,
                            "@read_bound": session_read_bound(read_damaged, &session_id, None),
                        },
                        |row| text_column(row, 0, |text| QueueItemId::new(&text)),
                    )?
                    .collect::<rusqlite::Result<HashSet<_>>>()
            })
            .map_err(QueueError::from)
    };
    // The other members of the pressed message's group, which the resend carries with it: those
    // of the group its landing names where the undo goes back before it, else, with the
    // conversation in scope, those that name the pressed message as their group's first, or,
    // where it opened its turn, those that name that turn's opening.
    let grouped: HashSet<QueueItemId> = match &group {
        Some((turn_number, start)) if checkpoint.checkpoint_id != pressed.checkpoint_id => {
            group_members(*turn_number, start)?
        }
        None if driver.is_some() => {
            let led = group_members(
                pressed.turn_number,
                &GroupStart::Message(pressed_message_id),
            )?;
            let opens_turn = led.is_empty()
                && turn_start_checkpoint(reader, session_id, run_id, pressed.turn_number)
                    .map_err(QueueError::from)?
                    .is_some_and(|start| start.checkpoint.checkpoint_id == pressed.checkpoint_id);
            if opens_turn {
                group_members(pressed.turn_number, &GroupStart::TurnOpening)?
            } else {
                led
            }
        }
        Some(_) | None => HashSet::new(),
    };
    let is_turn_reach = checkpoint.checkpoint_id != pressed.checkpoint_id;
    // The pressed message's run is read by run position, as its rollback cuts it, so a message
    // sent before the reach's that landed after it comes back too, and one sent after it that
    // landed in a turn before it, as a priority steer into the turn before, stays in the
    // conversation the cut leaves and out of the draft.
    let reached = checkpoints_reached_from(
        reader,
        read_damaged,
        session_id,
        &checkpoint,
        &later_run_ids,
    )
    .map_err(cut_error_of)?;
    let reached: Vec<&Checkpoint> = reached.iter().map(|stored| &stored.checkpoint).collect();
    let at_sequence = read_events(&reached)?;
    let is_resent = |cut: &Checkpoint, queue_item_id: QueueItemId| {
        if is_turn_reach || !grouped.is_empty() {
            cut.checkpoint_id == checkpoint.checkpoint_id
                || (cut.run_id == run_id
                    && cut.turn_number == pressed.turn_number
                    && grouped.contains(&queue_item_id))
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
                is_resent: is_resent(cut, queue_item_id),
            });
        }
    }
    // A turn whose start stands at a row of its own is cut before through the pressed message,
    // which the provider's cut takes with that turn's opening.
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

// The cut's refusal for a failed read of the reach's checkpoints.
fn cut_error_of(error: SupersededTurnsReadError) -> ConversationCutError {
    match error {
        SupersededTurnsReadError::Database(error) => QueueError::from(error).into(),
        SupersededTurnsReadError::Rollback(error) => ConversationCutError::Rollback(error),
    }
}
