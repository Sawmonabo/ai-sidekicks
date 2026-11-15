//! The reads of the checkpoints no later undo cut away: one by the point a request names, a
//! session's list, the one a turn's start wrote, the turns that reopened a prompt, the one before a
//! queue item's sent prompt, the lead's last one before a point at a prompt sent through the
//! queue, and those of the runs an undo reaches from a point on.

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::sync::LazyLock;

use rusqlite::{Connection, OptionalExtension as _, named_params};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::event_cursor::{
    SessionEventCursorUnresolvable, decode_event_cursor,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::restore::{SessionRestoreTarget, SnapshotId};
use sidekicks_contracts::transcript::turn_attribution::{SupersededTurns, transcript_run_stamp_at};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_store::database::stored_column::{safe_int_column, text_column};
use sidekicks_store::events::session::read::{readable_event_sql, session_read_bound};

use super::{Checkpoint, ReachedBindings, StoredCheckpoint, stored_checkpoint_of};
use crate::run::superseded::{
    StoredRollbackMismatchError, SupersededTurnsReadError, read_superseded_turns,
};

const CHECKPOINT_BY_ID_SQL: &str =
    select_checkpoints!("WHERE checkpoint_id = @checkpointId AND session_id = @sessionId");

const CHECKPOINT_BY_MESSAGE_SQL: &str =
    select_checkpoints!("WHERE session_id = @sessionId AND message_sequence = @messageSequence");

const CHECKPOINTS_OF_SESSION_SQL: &str =
    select_checkpoints!("WHERE session_id = @sessionId ORDER BY message_sequence");

// The checkpoint the start of turn `@turnNumber` of `@runId` wrote, the turn's first: each of the
// turn's steers takes a later position. Read on the checkpoints' turn index.
const TURN_START_CHECKPOINT_SQL: &str = select_checkpoints!(
    "WHERE run_id = @runId AND turn_number = @turnNumber AND session_id = @sessionId
  ORDER BY position LIMIT 1"
);

// The turns of `@runId` whose start reopened the prompt the queue item `@openingId` sent, read on
// the checkpoints' turn index.
const REOPENING_TURNS_SQL: &str = "SELECT DISTINCT turn_number FROM session_checkpoints
  WHERE run_id = @runId AND session_id = @sessionId AND turn_opening_id = @openingId
  ORDER BY turn_number";

// The checkpoint before the `user.message.sent` the queue item `@correlationId` was recorded as,
// found through the correlation index.
static SENT_MESSAGE_CHECKPOINT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{} AND message_sequence = (SELECT sequence FROM session_events
    WHERE correlation_id = @correlationId AND session_id = @sessionId AND type = '{}'
    ORDER BY sequence LIMIT 1)",
        select_checkpoints!("WHERE session_id = @sessionId"),
        SessionEventType::UserMessageSent.as_str()
    )
});

// The newest checkpoint of a lead run before `@messageSequence` that stands at a prompt sent
// through the queue, with its queue item, past each a rollback cut away: the k-th readable
// rollback of a run cuts its positions above its target in epochs k and earlier, the cuts
// `is_superseded` reads. Read newest first on the session's prompt order, so it stops at the
// first it keeps.
static LEAD_MESSAGE_BEFORE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "WITH rollbacks AS (
    SELECT run_id, json_extract(payload, '$.targetPosition') AS point,
      ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY sequence) - 1 AS rewound_epoch
    FROM session_events AS event
    WHERE session_id = @sessionId AND type = '{rolled_back}' AND {readable_rollback})
  SELECT kept.checkpoint_id, kept.session_id, kept.message_sequence, kept.run_id,
    kept.turn_number, kept.epoch, kept.position, kept.created_at, kept.turn_opening_id,
    json_extract(sent.payload, '$.queueItemId')
  FROM session_checkpoints AS kept
    JOIN runs ON runs.run_id = kept.run_id
    JOIN session_events AS sent
      ON sent.session_id = kept.session_id AND sent.sequence = kept.message_sequence
  WHERE kept.session_id = @sessionId AND kept.message_sequence < @messageSequence
    AND runs.parent_run_id IS NULL AND sent.type = '{sent}'
    AND json_extract(sent.payload, '$.queueItemId') IS NOT NULL AND {readable_sent}
    AND NOT EXISTS (SELECT 1 FROM rollbacks WHERE rollbacks.run_id = kept.run_id
      AND rollbacks.rewound_epoch >= kept.epoch AND rollbacks.point < kept.position)
  ORDER BY kept.message_sequence DESC LIMIT 1",
        rolled_back = SessionEventType::AgentRunRolledBack.as_str(),
        sent = SessionEventType::UserMessageSent.as_str(),
        readable_rollback = readable_event_sql("event"),
        readable_sent = readable_event_sql("sent"),
    )
});

// The checkpoints `reached_checkpoints!` names, in prompt order.
const CHECKPOINTS_REACHED_FROM_SQL: &str = concat!(
    select_checkpoints!("AS checkpoints\n WHERE "),
    reached_checkpoints!(),
    "\n ORDER BY checkpoints.message_sequence"
);

/// Why a checkpoint could not be read for an undo's target.
#[derive(Debug, thiserror::Error)]
pub enum CheckpointReadError {
    /// The target's message cursor names no place in the session's log.
    #[error(transparent)]
    CursorUnresolvable(#[from] SessionEventCursorUnresolvable),
    /// A later undo cut the conversation back past the checkpoint's turn, so the history it
    /// stands in no longer exists.
    #[error("checkpoint {} lies in history a later undo cut away", .checkpoint_id.as_str())]
    Superseded {
        /// The checkpoint.
        checkpoint_id: SnapshotId,
    },
    /// SQLite failed the read, or a stored column did not read as its type.
    #[error("the checkpoint could not be read")]
    Database(#[from] rusqlite::Error),
    /// A stored rollback of the checkpoint's run does not match its contract.
    #[error(transparent)]
    Rollback(#[from] StoredRollbackMismatchError),
}

impl From<SupersededTurnsReadError> for CheckpointReadError {
    fn from(error: SupersededTurnsReadError) -> Self {
        match error {
            SupersededTurnsReadError::Database(error) => Self::Database(error),
            SupersededTurnsReadError::Rollback(error) => Self::Rollback(error),
        }
    }
}

/// The checkpoint of `session_id` that `target` names: the one before the message its cursor
/// places, or the snapshot it names. `None` when the session holds no such checkpoint. The undos
/// that superseded it are read from the log as far as `read_damaged_from_sequence` lets it read.
/// Fails with [`CheckpointReadError::CursorUnresolvable`] for a cursor that names no place in the
/// log, [`CheckpointReadError::Superseded`] for a checkpoint a later undo cut away, and as SQLite
/// does or when a stored column or rollback does not read.
pub fn read_checkpoint(
    connection: &Connection,
    read_damaged_from_sequence: impl Fn(&SessionId) -> Option<i64>,
    session_id: SessionId,
    target: &SessionRestoreTarget,
) -> Result<Option<StoredCheckpoint>, CheckpointReadError> {
    let session = session_id.text();
    let checkpoint = match target {
        SessionRestoreTarget::Message { anchor_cursor } => {
            // The start of the log is no message, so no checkpoint stands there.
            let Ok(sequence) = u64::try_from(decode_event_cursor(anchor_cursor)?) else {
                return Ok(None);
            };
            let sequence =
                SafeInt::<0>::new(sequence).expect("a decoded cursor's position is a safe integer");
            connection
                .prepare_cached(CHECKPOINT_BY_MESSAGE_SQL)?
                .query_row(
                    named_params! {
                        "@sessionId": session.as_str(),
                        "@messageSequence": i64::from(sequence),
                    },
                    stored_checkpoint_of,
                )
                .optional()?
        }
        SessionRestoreTarget::Snapshot { snapshot_id } => connection
            .prepare_cached(CHECKPOINT_BY_ID_SQL)?
            .query_row(
                named_params! {
                    "@checkpointId": snapshot_id.as_str(),
                    "@sessionId": session.as_str(),
                },
                stored_checkpoint_of,
            )
            .optional()?,
    };
    if let Some(stored) = &checkpoint {
        let turns = read_superseded_turns(
            connection,
            read_damaged_from_sequence,
            &session_id,
            &stored.checkpoint.run_id,
        )?;
        if is_superseded(&turns, &stored.checkpoint) {
            return Err(CheckpointReadError::Superseded {
                checkpoint_id: stored.checkpoint.checkpoint_id.clone(),
            });
        }
    }
    Ok(checkpoint)
}

/// The checkpoint `checkpoint_id` of `session_id` as its row holds it, whether or not a cut took
/// its point; `None` where no such row stands. Fails as SQLite does.
pub fn read_kept_checkpoint(
    connection: &Connection,
    session_id: SessionId,
    checkpoint_id: &SnapshotId,
) -> rusqlite::Result<Option<Checkpoint>> {
    Ok(connection
        .prepare_cached(CHECKPOINT_BY_ID_SQL)?
        .query_row(
            named_params! {
                "@checkpointId": checkpoint_id.as_str(),
                "@sessionId": session_id.text().as_str(),
            },
            stored_checkpoint_of,
        )
        .optional()?
        .map(|stored| stored.checkpoint))
}

/// `session_id`'s checkpoints, oldest prompt first, but those a later undo cut away, read from the
/// log as far as `read_damaged_from_sequence` lets it read. Fails with the rollbacks' read error,
/// which also carries this list's own: [`SupersededTurnsReadError::Database`] when SQLite refuses
/// the checkpoints' read or a run's rollbacks' read, or a stored column does not read, and
/// [`SupersededTurnsReadError::Rollback`] when a stored rollback does not.
pub fn list_checkpoints(
    connection: &Connection,
    read_damaged_from_sequence: impl Fn(&SessionId) -> Option<i64>,
    session_id: SessionId,
) -> Result<Vec<StoredCheckpoint>, SupersededTurnsReadError> {
    let checkpoints = connection
        .prepare_cached(CHECKPOINTS_OF_SESSION_SQL)?
        .query_map(
            named_params! { "@sessionId": session_id.text().as_str() },
            stored_checkpoint_of,
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    kept_of(
        connection,
        read_damaged_from_sequence,
        session_id,
        checkpoints,
    )
}

/// The checkpoint the start of turn `turn_number` of `run_id` wrote in its own write, `None` when
/// the session holds none for it. A turn a steer still lands in stands whole in one epoch, so the
/// caller that reads it for a standing steer's turn needs no check that an undo cut it away.
/// Fails as SQLite does, or when a stored column does not read.
pub fn turn_start_checkpoint(
    connection: &Connection,
    session_id: SessionId,
    run_id: RunId,
    turn_number: SafeInt<1>,
) -> rusqlite::Result<Option<StoredCheckpoint>> {
    connection
        .prepare_cached(TURN_START_CHECKPOINT_SQL)?
        .query_row(
            named_params! {
                "@sessionId": session_id.text().as_str(),
                "@runId": run_id.text().as_str(),
                "@turnNumber": i64::from(turn_number),
            },
            stored_checkpoint_of,
        )
        .optional()
}

/// The turns of `run_id` whose start reopened the prompt the queue item `opening_id` sent, as a
/// retry turn's start does, oldest first. Fails as SQLite does, or when a stored turn number does
/// not read.
pub fn reopening_turn_numbers(
    connection: &Connection,
    session_id: SessionId,
    run_id: RunId,
    opening_id: QueueItemId,
) -> rusqlite::Result<Vec<SafeInt<1>>> {
    connection
        .prepare_cached(REOPENING_TURNS_SQL)?
        .query_map(
            named_params! {
                "@sessionId": session_id.text().as_str(),
                "@runId": run_id.text().as_str(),
                "@openingId": opening_id.to_string(),
            },
            |row| safe_int_column(row, 0),
        )?
        .collect()
}

/// The checkpoint before the prompt the queue item `queue_item_id` sent in `session_id`, `None`
/// where it sent none, no checkpoint holds it, or a later undo cut it away, read from the log as
/// far as `read_damaged_from_sequence` lets it read. Fails as [`list_checkpoints`] does.
pub fn sent_message_checkpoint(
    connection: &Connection,
    read_damaged_from_sequence: impl Fn(&SessionId) -> Option<i64>,
    session_id: SessionId,
    queue_item_id: QueueItemId,
) -> Result<Option<StoredCheckpoint>, SupersededTurnsReadError> {
    let checkpoint = connection
        .prepare_cached(&SENT_MESSAGE_CHECKPOINT_SQL)?
        .query_row(
            named_params! {
                "@sessionId": session_id.text().as_str(),
                "@correlationId": queue_item_id.to_string(),
            },
            stored_checkpoint_of,
        )
        .optional()?;
    Ok(kept_of(
        connection,
        read_damaged_from_sequence,
        session_id,
        checkpoint.into_iter().collect(),
    )?
    .pop())
}

/// The newest checkpoint of a lead run before `reach` in `session_id` that stands at a prompt sent
/// through the queue, with its queue item, past those a later undo cut away and the starts of
/// turns no new prompt opened; `None` where none stands before it. One read however many
/// checkpoints earlier undos cut away, the rollbacks read as far as `read_damaged_from_sequence`
/// lets the log read. Fails as SQLite does, or when a stored column does not read.
pub fn lead_message_checkpoint_before(
    connection: &Connection,
    read_damaged_from_sequence: impl Fn(&SessionId) -> Option<i64>,
    session_id: SessionId,
    reach: &Checkpoint,
) -> rusqlite::Result<Option<(Checkpoint, QueueItemId)>> {
    connection
        .prepare_cached(&LEAD_MESSAGE_BEFORE_SQL)?
        .query_row(
            named_params! {
                "@sessionId": session_id.text().as_str(),
                "@messageSequence": i64::from(reach.message_sequence),
                "@read_bound": session_read_bound(read_damaged_from_sequence, &session_id, None),
            },
            |row| {
                Ok((
                    stored_checkpoint_of(row)?.checkpoint,
                    text_column(row, 9, |text| QueueItemId::new(&text))?,
                ))
            },
        )
        .optional()
}

/// The checkpoints an undo to `reach` in `session_id` takes, oldest prompt first, but those a
/// later undo cut away: those of `reach`'s run from its run position on, whenever their prompts
/// were sent, and those of the later lead runs `later_run_ids`, each whole, as the rollback and
/// [`versions_after`](super::versions_after) take them; one read of the rows, then one of each
/// listed run's rollbacks. Fails as [`list_checkpoints`] does.
pub fn checkpoints_reached_from(
    connection: &Connection,
    read_damaged_from_sequence: impl Fn(&SessionId) -> Option<i64>,
    session_id: SessionId,
    reach: &Checkpoint,
    later_run_ids: &[RunId],
) -> Result<Vec<StoredCheckpoint>, SupersededTurnsReadError> {
    let bindings = ReachedBindings::new(session_id, reach, later_run_ids);
    let checkpoints = connection
        .prepare_cached(CHECKPOINTS_REACHED_FROM_SQL)?
        .query_map(bindings.params().as_slice(), stored_checkpoint_of)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    kept_of(
        connection,
        read_damaged_from_sequence,
        session_id,
        checkpoints,
    )
}

// The checkpoints among `checkpoints` no later undo cut away, in their order, each run's
// rollbacks read once.
fn kept_of(
    connection: &Connection,
    read_damaged_from_sequence: impl Fn(&SessionId) -> Option<i64>,
    session_id: SessionId,
    checkpoints: Vec<StoredCheckpoint>,
) -> Result<Vec<StoredCheckpoint>, SupersededTurnsReadError> {
    let mut turns_by_run: HashMap<RunId, SupersededTurns> = HashMap::new();
    let mut kept = Vec::with_capacity(checkpoints.len());
    for stored in checkpoints {
        let run_id = stored.checkpoint.run_id;
        let turns = match turns_by_run.entry(run_id) {
            Entry::Occupied(entry) => entry.into_mut(),
            Entry::Vacant(entry) => entry.insert(read_superseded_turns(
                connection,
                &read_damaged_from_sequence,
                &session_id,
                &run_id,
            )?),
        };
        if !is_superseded(turns, &stored.checkpoint) {
            kept.push(stored);
        }
    }
    Ok(kept)
}

// Whether a rollback of the checkpoint's run cut its turn away.
fn is_superseded(turns: &SupersededTurns, checkpoint: &Checkpoint) -> bool {
    transcript_run_stamp_at(turns, checkpoint.turn)
        .superseded
        .is_some()
}
