//! The part of a row's body `transcript.body.read` answers: the row named by the id of the event it
//! stands at, its body the pieces the provider sent it in, joined through the read's head. Only the
//! stored pieces one part covers are read, so a long body read part by part is read once.

use rusqlite::Connection;
use sidekicks_contracts::jsonrpc::page::PAGE_MAX_BYTES;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::content::{
    BodyReadOffsetRefused, BodyWindow, TranscriptBodyReadResponse, stored_body_content_of,
};

use crate::database::connection::read_pool::DatabaseReadError;
use crate::events::session::read::SessionEventReads;
use crate::ipc::registry::HandlerError;
use crate::transcript::rejoin::{RowReads, joined_body_of};
use crate::transcript::window::{TranscriptReadError, read_transcript_head};

/// Why a row's body could not be read.
#[derive(Debug, thiserror::Error)]
pub(crate) enum BodyReadError {
    /// The session is not one this daemon holds, or a read of its log failed.
    #[error(transparent)]
    Read(#[from] TranscriptReadError),
    /// The offset is inside a character or past the body's end.
    #[error(transparent)]
    Offset(#[from] BodyReadOffsetRefused),
}

impl From<DatabaseReadError> for BodyReadError {
    fn from(error: DatabaseReadError) -> Self {
        Self::Read(error.into())
    }
}

impl From<BodyReadError> for HandlerError {
    /// A refusal answers by its code; a failed read is a fault in the daemon.
    fn from(error: BodyReadError) -> Self {
        match error {
            BodyReadError::Read(error) => error.into(),
            BodyReadError::Offset(refused) => refused.into(),
        }
    }
}

/// The part from `offset` of the body of `session_id`'s row standing at the event `row_id`, read
/// on `reader`, or `None` when no row of the session stands there; `read_damaged_from_sequence`
/// answers where a damaged session's reads stop. Fails with [`TranscriptReadError::Refused`]
/// (`session.notFound`) for a session this daemon holds no events for, with
/// [`BodyReadError::Offset`] for an offset that is no place to resume from, and with
/// [`TranscriptReadError`]'s faults when a read fails.
pub(crate) fn read_row_body<DamagedFrom>(
    reader: &Connection,
    read_damaged_from_sequence: &DamagedFrom,
    session_id: &SessionId,
    row_id: &str,
    offset: u64,
) -> Result<Option<TranscriptBodyReadResponse>, BodyReadError>
where
    DamagedFrom: Fn(&SessionId) -> Option<i64> + ?Sized,
{
    let snapshot = reader
        .unchecked_transaction()
        .map_err(TranscriptReadError::from)?;
    let reads = SessionEventReads::new(reader, read_damaged_from_sequence);
    let head = read_transcript_head(&reads, read_damaged_from_sequence, session_id)?;
    let Some(stored_row) = reads
        .read_stored_row(session_id, row_id)
        .map_err(TranscriptReadError::from)?
    else {
        return Ok(None);
    };
    let sequence = i64::from(stored_row.envelope.sequence);
    let rows_of = RowReads::new(&reads, reader, session_id);
    if rows_of
        .row_at(sequence)
        .map_err(TranscriptReadError::from)?
        != Some(sequence)
    {
        return Ok(None);
    }
    let head = head.expect("a session holding a readable row has a head");
    // No text is loaded here: only the pieces the part covers are read below.
    let members = rows_of
        .row_members(&[sequence], head, -1)
        .map_err(TranscriptReadError::from)?
        .remove(&sequence)
        .unwrap_or_default();
    let piece_bounds: Vec<(i64, usize)> = members
        .iter()
        .map(|member| {
            let length = usize::try_from(member.byte_length).expect("a piece's size fits memory");
            (member.sequence, length)
        })
        .collect();
    let payload = &stored_row.envelope.payload;
    let Some(joined) = joined_body_of(sequence, payload, members) else {
        return Ok(Some(stored_body_content_of(Some(payload), None, offset)?));
    };
    let body_length: usize = piece_bounds.iter().map(|(_, length)| length).sum();
    let wanted_from = usize::try_from(offset).unwrap_or(usize::MAX);
    // One part holds at most a page of text, so the pieces from the one holding `offset` through a
    // page past it hold the whole part.
    let wanted_to = wanted_from.saturating_add(PAGE_MAX_BYTES);
    let mut window_start = body_length;
    let mut wanted_sequences = Vec::new();
    let mut piece_start = 0;
    for (piece_sequence, length) in piece_bounds {
        let piece_end = piece_start + length;
        if piece_end > wanted_from && piece_start < wanted_to {
            window_start = window_start.min(piece_start);
            wanted_sequences.push(piece_sequence);
        }
        piece_start = piece_end;
    }
    let window_text = rows_of
        .piece_texts(&wanted_sequences)
        .map_err(TranscriptReadError::from)?;
    let part = stored_body_content_of(
        Some(&joined.facts),
        Some(BodyWindow {
            text: &window_text,
            start: window_start,
            body_length,
        }),
        offset,
    )?;
    snapshot.commit().map_err(TranscriptReadError::from)?;
    Ok(Some(part))
}
