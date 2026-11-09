//! What an undo to one of the person's messages reaches: the checkpoint it goes back to, which is
//! the pressed message's own, or the opening's of the turn a steer joined where the provider's
//! conversation cut lands only at turns and the conversation is in scope, and the person's
//! messages it takes back, read from the daemon's own queue items in send order.

use std::sync::{Arc, LazyLock};

use rusqlite::{Connection, named_params};
use sidekicks_contracts::artifacts::attachment_reference::AttachmentReferenceList;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::restore::{
    SessionRestoreResend, SessionRestoreScope, SessionRestoreTarget,
};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::driver::contract::ProviderDriver;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_session::checkpoints::store::{
    Checkpoint, CheckpointReadError, list_checkpoints, read_checkpoint,
};
use sidekicks_session::driver_resolution::LiveRunDriverError;
use sidekicks_session::queue_store::{QueueItemReader, QueueMessageBody};
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

// The positions of the steers of the turn the message `@message_id` steered into on `@run_id`, in
// the order they landed; none when that message steered no turn. A run's turn numbers never
// repeat, so the number names the turn.
static TURN_STEER_POSITIONS_SQL: LazyLock<String> = LazyLock::new(|| {
    let steered = SessionEventType::AgentTurnSteered.as_str();
    format!(
        "SELECT json_extract(event.payload, '$.position') FROM session_events AS event
  WHERE event.session_id = @session_id AND event.run_id = @run_id AND event.type = '{steered}'
    AND {}
    AND json_extract(event.payload, '$.turnNumber') = (
      SELECT json_extract(steer.payload, '$.turnNumber') FROM session_events AS steer
       WHERE steer.session_id = @session_id AND steer.run_id = @run_id
         AND steer.type = '{steered}' AND {}
         AND json_extract(steer.payload, '$.messageId') = @message_id
       ORDER BY steer.sequence DESC
       LIMIT 1)
  ORDER BY event.sequence",
        readable_event_sql("event"),
        readable_event_sql("steer"),
    )
});

/// What an undo to one of the person's messages goes back to, read before anything is stopped:
/// the preview and the conversation cut read it alike.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UndoReach {
    /// The checkpoint the undo goes back to, conversation and files together: the pressed
    /// message's own, or, with the conversation in scope on a provider whose cut lands only at
    /// turns, the opening's of the turn the pressed message steered into.
    pub checkpoint: Checkpoint,
    /// The queue item of the person's message at `checkpoint`, the id the provider knows it by.
    pub message_id: QueueItemId,
    /// The queue item of the message the person pressed.
    pub pressed_message_id: QueueItemId,
    /// Each of the person's messages the undo takes back, from `checkpoint` on, in send order:
    /// what goes back into the draft.
    pub cut_messages: Vec<CutMessage>,
}

/// One of the person's messages an undo takes back.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CutMessage {
    /// Its queue item.
    pub queue_item_id: QueueItemId,
    /// What it carried, as its queue item holds it.
    pub body: QueueMessageBody,
    /// Whether a resend of an edit of the pressed message carries it: the pressed message, and,
    /// where the undo goes back to the opening of the pressed message's turn, every message of
    /// that turn.
    pub is_resent: bool,
}

impl UndoReach {
    /// Whether the undo goes back to the pressed message itself; where it does not, the ask names
    /// the opening's words, the first of `cut_messages`.
    pub fn is_pressed_message(&self) -> bool {
        self.message_id == self.pressed_message_id
    }

    /// The one message a resend of `edited`, the pressed message's edit, sends as the new turn:
    /// `edited` alone where the undo goes back to the pressed message, else each message of its
    /// turn in send order, the edit in the pressed one's place, their words joined by a blank line
    /// and their files in the same order.
    pub fn resend_with(&self, edited: SessionRestoreResend) -> SessionRestoreResend {
        if self.is_pressed_message() {
            return edited;
        }
        let mut words = Vec::new();
        let mut attachments = Vec::new();
        for message in self.cut_messages.iter().filter(|message| message.is_resent) {
            if message.queue_item_id == self.pressed_message_id {
                words.push(edited.content.as_str());
                attachments.extend(edited.attachments.iter().flat_map(|files| files.0.clone()));
            } else {
                words.push(message.body.content.as_str());
                attachments.extend(message.body.attachment_ids());
            }
        }
        SessionRestoreResend {
            content: FreeFormText::new(words.join("\n\n"))
                .expect("free-form words joined by a blank line stay free-form text"),
            attachments: (!attachments.is_empty()).then_some(AttachmentReferenceList(attachments)),
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
    let checkpoints = match list_checkpoints(reader, read_damaged, session_id) {
        Ok(checkpoints) => checkpoints,
        Err(SupersededTurnsReadError::Database(error)) => {
            return Err(QueueError::from(error).into());
        }
        Err(SupersededTurnsReadError::Rollback(error)) => {
            return Err(ConversationCutError::Rollback(error));
        }
    };
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
    // Every checkpoint of the runs the cut reaches, in send order.
    let reached: Vec<&Checkpoint> = checkpoints
        .iter()
        .map(|stored| &stored.checkpoint)
        .filter(|checkpoint| {
            checkpoint.run_id == run_id || later_run_ids.contains(&checkpoint.run_id)
        })
        .collect();
    let sequences: Vec<i64> = reached
        .iter()
        .map(|checkpoint| i64::from(checkpoint.message_sequence))
        .collect();
    let sent = SessionEventReads::new(reader, read_damaged)
        .read_at_sequences(&session_id, &sequences)
        .map_err(QueueError::from)?;
    let mut sent_ids = Vec::with_capacity(sent.len());
    for envelope in &sent {
        if let SessionEvent::UserMessageSent(payload) =
            SessionEvent::from_envelope(envelope).map_err(QueueError::from)?
        {
            sent_ids.push((envelope.sequence, payload.queue_item_id));
        }
    }
    let message_id_at = |checkpoint: &Checkpoint| {
        sent_ids
            .iter()
            .find(|(sequence, _)| *sequence == checkpoint.message_sequence)
            .and_then(|(_, queue_item_id)| *queue_item_id)
            .ok_or(ConversationCutError::MessageNotQueued)
    };
    let pressed_message_id = message_id_at(&pressed)?;
    let steer_positions = reader
        .prepare_cached(&TURN_STEER_POSITIONS_SQL)
        .and_then(|mut statement| {
            statement
                .query_map(
                    named_params! {
                        "@session_id": session_id.text().as_str(),
                        "@run_id": run_id.text().as_str(),
                        "@message_id": pressed_message_id.to_string(),
                        "@read_bound": session_read_bound(read_damaged, &session_id, None),
                    },
                    |row| safe_int_column::<0>(row, 0),
                )?
                .collect::<rusqlite::Result<Vec<SafeInt<0>>>>()
        })
        .map_err(QueueError::from)?;
    let driver = match scope {
        SessionRestoreScope::ConversationAndFiles | SessionRestoreScope::Conversation => {
            let provider = read_run_provider(reader, &run_id)
                .map_err(QueueError::from)?
                .ok_or(LiveRunDriverError::Unbound { run_id })
                .map_err(QueueError::from)?
                .provider;
            let driver = providers
                .lookup(&provider)
                .map_err(LiveRunDriverError::ProviderNotFound)
                .map_err(QueueError::from)?;
            Some(driver)
        }
        SessionRestoreScope::Files => None,
    };
    let cuts_only_at_turns = driver
        .as_ref()
        .is_some_and(|driver| !driver.can_cut_inside_turn());
    // The first and last positions of the pressed steer's turn where the undo goes back to its
    // opening: a turn's steers take the positions right after its opening's.
    let opening_turn = steer_positions
        .first()
        .zip(steer_positions.last())
        .filter(|_| cuts_only_at_turns)
        .map(|(first, last)| (first.get() - 1, last.get()));
    let (checkpoint, message_id) = match opening_turn {
        Some((opening_position, _)) => {
            let opening = reached
                .iter()
                .copied()
                .find(|checkpoint| {
                    checkpoint.run_id == run_id
                        && checkpoint.turn.epoch == pressed.turn.epoch
                        && checkpoint.turn.position.0.get() == opening_position
                })
                .ok_or(ConversationCutError::MessageNotQueued)?;
            (opening.clone(), message_id_at(opening)?)
        }
        None => (pressed.clone(), pressed_message_id),
    };
    let is_in_resent_turn = |cut: &Checkpoint| match opening_turn {
        Some((opening_position, last_position)) => {
            cut.run_id == run_id
                && cut.turn.epoch == pressed.turn.epoch
                && (opening_position..=last_position).contains(&cut.turn.position.0.get())
        }
        None => cut.checkpoint_id == pressed.checkpoint_id,
    };
    let items = QueueItemReader::new(reader);
    let mut cut_messages = Vec::new();
    for cut in reached
        .iter()
        .copied()
        .filter(|cut| cut.message_sequence >= checkpoint.message_sequence)
    {
        let queue_item_id = message_id_at(cut)?;
        let item = items
            .get(&queue_item_id)
            .map_err(QueueError::from)?
            .ok_or(ConversationCutError::MessageNotQueued)?;
        // A review or a plan's message is the daemon's, not the person's words.
        if let Some(body) = item.body.as_message() {
            cut_messages.push(CutMessage {
                queue_item_id,
                body: body.clone(),
                is_resent: is_in_resent_turn(cut),
            });
        }
    }
    Ok(ReachRead {
        reach: UndoReach {
            checkpoint,
            message_id,
            pressed_message_id,
            cut_messages,
        },
        later_run_ids,
        driver,
    })
}
