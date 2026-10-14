//! One session's event log read as transcript rows. Every event of a run is stamped with its turn
//! position, its execution epoch and, when an undo rolled its turn back, the superseded marker; a
//! `run.rolled_back` becomes the typed boundary row; an event naming no run is a general row. Every
//! row carries its body, read for the whole window in one statement; a large body is read as its
//! size alone, so a page of large outputs costs no more than their lengths.

use std::collections::HashMap;

use rusqlite::{Connection, params};
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::session::event_cursor::encode_event_cursor;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::content::{StoredRowBody, transcript_row_content_of};
use sidekicks_contracts::transcript::limits::TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES;
use sidekicks_contracts::transcript::row::{
    RollbackBoundaryType, RunLifecycleCategory, RunScopedTranscriptEntry, TranscriptEntry,
    TranscriptReadRow, TranscriptRollbackBoundary,
};
use sidekicks_contracts::wire::instant::{NotAnInstant, WireInstant};
use sidekicks_contracts::wire::integer::{SafeInt, count_bound};

use crate::database::stored_column::safe_int_column;
use crate::transcript::turn_attribution::{
    RunEventAttribution, RunTurnReads, SessionTurnAttribution, TurnAttributionError,
};

/// The most UTF-8 bytes a stored body is read with its row: a JSON string takes its text's bytes
/// plus its two quotes, so a longer body cannot travel inline and is read as its size alone.
const TRANSCRIPT_ROW_BODY_INLINE_MAX_UTF8_BYTES: i64 =
    count_bound(TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES - 2);

// The bodies of a window's events, one row per event that has one stored: each body's UTF-8 size,
// and its text only when that size lets it travel, so a large body is never read into memory.
const SELECT_STORED_BODIES_SQL: &str = "SELECT sequence, octet_length(content_payload),
       CASE WHEN octet_length(content_payload) <= ? THEN content_payload END
  FROM session_events
 WHERE session_id = ? AND content_payload IS NOT NULL
   AND sequence IN (SELECT value FROM json_each(?))";

/// Why a window of events could not be projected into rows.
#[derive(Debug, thiserror::Error)]
pub(crate) enum TranscriptProjectionError {
    /// SQLite refused the bodies' read, or a stored size is not a safe integer.
    #[error("the read of a transcript window's bodies failed")]
    Database(#[from] rusqlite::Error),
    /// An event could not be attributed to its turn.
    #[error(transparent)]
    Attribution(#[from] TurnAttributionError),
    /// An event's stored time is not an instant with its seconds and offset, which only a write
    /// outside the append path can leave.
    #[error("the event at sequence {sequence} holds a time that is not a full instant")]
    OccurredAt {
        /// The event's sequence.
        sequence: u64,
        /// Why the time is not an instant.
        #[source]
        cause: NotAnInstant,
    },
}

/// One row per event of `events`, a contiguous ascending stretch of `session_id`'s log, in the same
/// order, each stamped and carrying its body, read on `reader`; `read_damaged_from_sequence`
/// answers where a damaged session's reads stop. Fails with
/// [`TranscriptProjectionError::Attribution`] on a `run.rolled_back` that does not match its
/// contract or a seed read that fails, and with [`TranscriptProjectionError::Database`] when the
/// bodies' read fails.
pub(crate) fn project_window<DamagedFrom>(
    reader: &Connection,
    read_damaged_from_sequence: DamagedFrom,
    session_id: &SessionId,
    events: &[EventEnvelope],
) -> Result<Vec<TranscriptReadRow>, TranscriptProjectionError>
where
    DamagedFrom: Fn(&SessionId) -> Option<i64>,
{
    let reads = RunTurnReads::new(reader, read_damaged_from_sequence);
    let mut attribution = SessionTurnAttribution::new(*session_id);
    let sequences: Vec<u64> = events.iter().map(|event| event.sequence.get()).collect();
    let stored_body_by_sequence = reader
        .prepare_cached(SELECT_STORED_BODIES_SQL)?
        .query_map(
            params![
                TRANSCRIPT_ROW_BODY_INLINE_MAX_UTF8_BYTES,
                session_id.text().as_str(),
                serde_json::to_string(&sequences).expect("a list of integers serializes"),
            ],
            |row| {
                Ok((
                    safe_int_column::<0>(row, 0)?.get(),
                    (
                        safe_int_column::<0>(row, 1)?,
                        row.get::<_, Option<String>>(2)?,
                    ),
                ))
            },
        )?
        .collect::<rusqlite::Result<HashMap<u64, (SafeInt<0>, Option<String>)>>>()?;
    events
        .iter()
        .map(|event| {
            let stored =
                stored_body_by_sequence
                    .get(&event.sequence.get())
                    .map(|(byte_length, body)| StoredRowBody {
                        byte_length: *byte_length,
                        body: body.as_deref(),
                    });
            let attributed = attribution.attribute(&reads, event)?;
            row_of(event, attributed, stored)
        })
        .collect()
}

fn row_of(
    event: &EventEnvelope,
    attributed: Option<RunEventAttribution>,
    stored: Option<StoredRowBody<'_>>,
) -> Result<TranscriptReadRow, TranscriptProjectionError> {
    let content = transcript_row_content_of(Some(&event.payload), stored);
    let timestamp =
        WireInstant::try_from(event.occurred_at.as_str().to_owned()).map_err(|cause| {
            TranscriptProjectionError::OccurredAt {
                sequence: event.sequence.get(),
                cause,
            }
        })?;
    let cursor = encode_event_cursor(i64::from(event.sequence))
        .expect("an envelope's sequence is a safe integer");
    // A system event names no actor, which the row leaves out.
    let actor = event.actor.clone().flatten();
    let Some(RunEventAttribution {
        run_id,
        stamp,
        rollback,
    }) = attributed
    else {
        return Ok(TranscriptReadRow::General(TranscriptEntry {
            id: event.id.clone(),
            session_id: event.session_id,
            sequence: event.sequence,
            cursor,
            actor,
            timestamp,
            child_run_summary: None,
            omitted_patches: None,
            content,
            category: event.category,
            event_type: event.event_type.0.clone(),
            payload: event.payload.clone(),
        }));
    };
    Ok(match rollback {
        Some(rollback) => TranscriptReadRow::RollbackBoundary(TranscriptRollbackBoundary {
            id: event.id.clone(),
            session_id: event.session_id,
            sequence: event.sequence,
            cursor,
            actor,
            timestamp,
            child_run_summary: None,
            omitted_patches: None,
            content,
            category: RunLifecycleCategory::Value,
            event_type: RollbackBoundaryType::Value,
            run_id,
            position: stamp.position,
            epoch: stamp.epoch,
            superseded: stamp.superseded,
            payload: rollback,
        }),
        None => TranscriptReadRow::Run(RunScopedTranscriptEntry {
            id: event.id.clone(),
            session_id: event.session_id,
            sequence: event.sequence,
            cursor,
            actor,
            timestamp,
            child_run_summary: None,
            omitted_patches: None,
            content,
            category: event.category,
            event_type: event.event_type.0.clone(),
            run_id,
            position: stamp.position,
            epoch: stamp.epoch,
            superseded: stamp.superseded,
            payload: event.payload.clone(),
        }),
    })
}
