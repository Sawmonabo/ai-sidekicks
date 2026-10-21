//! One session's event log read as transcript rows. Every event of a run is stamped with its turn
//! position, its execution epoch and, when an undo rolled its turn back, the superseded marker; a
//! `agent.run.rolledBack` becomes the typed boundary row; an event naming no run is a general row.
//! A reply or reasoning the provider sent in pieces is one row, standing at its first piece, its
//! body the pieces joined through the read's head. Every row carries its body, read for the whole
//! window in one statement; a large body is read as its size alone, so a page of large outputs
//! costs no more than their lengths. A reply drawn as markdown carries its block starts, only
//! those no later text can move while it is still arriving, or why its cut failed.

use rusqlite::Connection;
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::session::event_cursor::encode_event_cursor;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::content::TranscriptRowContent;
use sidekicks_contracts::transcript::limits::TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES;
use sidekicks_contracts::transcript::row::{
    RollbackBoundaryType, RunLifecycleCategory, RunScopedTranscriptEntry, TranscriptEntry,
    TranscriptOmittedPatch, TranscriptReadRow, TranscriptRollbackBoundary,
};
use sidekicks_contracts::wire::instant::{NotAnInstant, WireInstant};
use sidekicks_contracts::wire::integer::count_bound;
use sidekicks_contracts::wire::list::BoundedVec;

use crate::events::session::read::{
    MalformedStoredEventError, MalformedStoredEventFault, SessionEventReads,
};
use crate::transcript::block_cut::{prose_body_of, with_block_starts};
use crate::transcript::rejoin::{RowReads, joined_body_of, joined_row_content_of};
use crate::transcript::turn_attribution::{
    RunEventAttribution, RunTurnReads, SessionTurnAttribution, TurnAttributionError,
};
use crate::transcript::whole_patch::OMITTED_PATCHES_PAYLOAD_KEY;

/// The most UTF-8 bytes a row's body is read with its row: a JSON string takes its text's bytes
/// plus its two quotes, so a longer body cannot travel inline and is read as its size alone.
pub(crate) const TRANSCRIPT_ROW_BODY_INLINE_MAX_UTF8_BYTES: i64 =
    count_bound(TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES - 2);

/// Why a window of events could not be projected into rows.
#[derive(Debug, thiserror::Error)]
pub(crate) enum TranscriptProjectionError {
    /// SQLite refused the bodies' read, or a stored size is not a safe integer.
    #[error("the read of a transcript window's bodies failed")]
    Database(#[from] rusqlite::Error),
    /// An event could not be attributed to its turn.
    #[error(transparent)]
    Attribution(#[from] TurnAttributionError),
    /// A stored row does not hold its event's form: a tool completion's list of the files it
    /// left out does not read.
    #[error(transparent)]
    Malformed(#[from] MalformedStoredEventError),
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

/// One row per event of `rows`, events of `session_id`'s log that each stand as a row, in
/// ascending order, each stamped and carrying its body joined through `head`, read on `reader`;
/// `read_damaged_from_sequence` answers where a damaged session's reads stop. Fails with
/// [`TranscriptProjectionError::Attribution`] on an `agent.run.rolledBack` that does not match its
/// contract or a seed read that fails, with [`TranscriptProjectionError::Database`] when the
/// bodies' read fails, and with [`TranscriptProjectionError::Malformed`] on a tool completion whose
/// list of left-out files does not read.
pub(crate) fn project_window<DamagedFrom>(
    reader: &Connection,
    read_damaged_from_sequence: DamagedFrom,
    session_id: &SessionId,
    rows: &[EventEnvelope],
    head: i64,
) -> Result<Vec<TranscriptReadRow>, TranscriptProjectionError>
where
    DamagedFrom: Fn(&SessionId) -> Option<i64>,
{
    let session_reads = SessionEventReads::new(reader, &read_damaged_from_sequence);
    let row_sequences: Vec<i64> = rows.iter().map(|row| i64::from(row.sequence)).collect();
    let row_reads = RowReads::new(&session_reads, reader, session_id);
    let mut members_by_row = row_reads.row_members(
        &row_sequences,
        head,
        TRANSCRIPT_ROW_BODY_INLINE_MAX_UTF8_BYTES,
    )?;
    // The replies whose text travels and may be cut into blocks, each with its last piece, so the
    // ones still arriving are cut holding back their last blocks.
    let prose_rows: Vec<(i64, i64)> = rows
        .iter()
        .filter(|event| prose_body_of(event.event_type.0.as_str(), &event.payload).is_some())
        .filter_map(|event| {
            let sequence = i64::from(event.sequence);
            let members = members_by_row.get(&sequence)?;
            let last = members.last()?;
            members
                .iter()
                .all(|member| member.text.is_some())
                .then_some((sequence, last.sequence))
        })
        .collect();
    let unended_rows = row_reads.unended_rows(&prose_rows, head)?;
    let reads = RunTurnReads::new(reader, &read_damaged_from_sequence);
    let mut attribution = SessionTurnAttribution::new(*session_id);
    rows.iter()
        .map(|event| {
            let sequence = i64::from(event.sequence);
            let body = members_by_row
                .remove(&sequence)
                .and_then(|members| joined_body_of(sequence, &event.payload, members));
            let content = with_block_starts(
                joined_row_content_of(&event.payload, body.as_ref()),
                prose_body_of(event.event_type.0.as_str(), &event.payload),
                !unended_rows.contains(&sequence),
            );
            let attributed = attribution.attribute(&reads, event)?;
            row_of(event, attributed, content)
        })
        .collect()
}

fn row_of(
    event: &EventEnvelope,
    attributed: Option<RunEventAttribution>,
    content: TranscriptRowContent,
) -> Result<TranscriptReadRow, TranscriptProjectionError> {
    let omitted_patches = omitted_patches_of(event, &content)?;
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
            omitted_patches,
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
            omitted_patches,
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
            omitted_patches,
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

/// The patches a tool completion's row names as left out.
type OmittedPatches = BoundedVec<TranscriptOmittedPatch, 1, { usize::MAX }>;

// The patches a tool completion's row leaves out: every file its producer named, when its body is
// too large to travel with the row. A list that does not read is a malformed stored row.
fn omitted_patches_of(
    event: &EventEnvelope,
    content: &TranscriptRowContent,
) -> Result<Option<OmittedPatches>, MalformedStoredEventError> {
    if event.event_type.0.as_str() != SessionEventType::AgentToolCallCompleted.as_str()
        || !matches!(content, TranscriptRowContent::Large { .. })
    {
        return Ok(None);
    }
    let Some(patches) = event.payload.get(OMITTED_PATCHES_PAYLOAD_KEY) else {
        return Ok(None);
    };
    serde_json::from_value(patches.clone())
        .map(Some)
        .map_err(|cause| MalformedStoredEventError {
            event_id: event.id.as_str().to_owned(),
            session_id: event.session_id.to_string(),
            sequence: i64::from(event.sequence),
            fault: MalformedStoredEventFault::Column {
                column: "payload",
                cause: Some(Box::new(cause)),
            },
        })
}
