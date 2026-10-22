//! The part of a row's body `transcript.body.read` answers: the row named by the id of the event it
//! stands at, its body the pieces the provider sent it in, joined through the read's head. A body
//! is read only through the stored pieces one part covers, and of a compressed piece only the
//! frames it covers, so a long body read part by part is decoded once. A reply that may be drawn
//! as markdown needs its whole text to be cut: an ended one is cut once and its cut kept, so its
//! later parts read only their frames, and one still taking pieces is read whole for each part.
//! Each part carries the block starts that fall in it.

pub(crate) mod starts_cache;

use rusqlite::Connection;
use sidekicks_contracts::jsonrpc::page::PAGE_MAX_BYTES;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::content::{
    BodyBlockCut, BodyReadOffsetRefused, BodyWindow, TranscriptBodyReadResponse,
    stored_body_content_of,
};

use crate::database::connection::read_pool::DatabaseReadError;
use crate::events::session::read::SessionEventReads;
use crate::ipc::registry::HandlerError;
use crate::transcript::block_cut::{BlockParse, body_block_starts, prose_body_of};
use crate::transcript::body::starts_cache::{
    BlockCutKey, EndedBlockCut, keep_block_cut, kept_block_cut,
};
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

/// Whether the body of the event `row_id` of `session_id` is cut into blocks, so that a read of it
/// loads it whole: a reply that may be drawn as markdown. Reads the event alone, not its body, on
/// `reader`; `read_damaged_from_sequence` answers where a damaged session's reads stop. Fails with
/// [`TranscriptReadError`]'s faults when the read fails.
pub(crate) fn is_body_cut_into_blocks<DamagedFrom>(
    reader: &Connection,
    read_damaged_from_sequence: &DamagedFrom,
    session_id: &SessionId,
    row_id: &str,
) -> Result<bool, BodyReadError>
where
    DamagedFrom: Fn(&SessionId) -> Option<i64> + ?Sized,
{
    let event = SessionEventReads::new(reader, read_damaged_from_sequence)
        .read_event(session_id, row_id)
        .map_err(TranscriptReadError::from)?;
    Ok(event
        .is_some_and(|event| prose_body_of(event.event_type.0.as_str(), &event.payload).is_some()))
}

/// The part from `offset` of the body of `session_id`'s row standing at the event `row_id`, read
/// on `reader`, a reply's cut into blocks by `parse`, or `None` when no row of the session stands
/// there; `read_damaged_from_sequence` answers where a damaged session's reads stop. A reply drawn
/// as markdown is loaded whole, which [`is_body_cut_into_blocks`] tells before the read. Fails
/// with [`TranscriptReadError::Refused`] (`session.notFound`) for a session this daemon holds no
/// events for, with [`BodyReadError::Offset`] for an offset that is no place to resume from, and
/// with [`TranscriptReadError`]'s faults when a read fails.
pub(crate) fn read_row_body<DamagedFrom>(
    reader: &Connection,
    read_damaged_from_sequence: &DamagedFrom,
    session_id: &SessionId,
    row_id: &str,
    offset: u64,
    parse: BlockParse,
) -> Result<Option<TranscriptBodyReadResponse>, BodyReadError>
where
    DamagedFrom: Fn(&SessionId) -> Option<i64> + ?Sized,
{
    let snapshot = reader
        .unchecked_transaction()
        .map_err(TranscriptReadError::from)?;
    let reads = SessionEventReads::new(reader, read_damaged_from_sequence);
    let head = read_transcript_head(&reads, read_damaged_from_sequence, session_id)?;
    let Some(event) = reads
        .read_event(session_id, row_id)
        .map_err(TranscriptReadError::from)?
    else {
        return Ok(None);
    };
    let sequence = i64::from(event.sequence);
    let rows_of = RowReads::new(&reads, reader, session_id);
    if rows_of
        .row_at(sequence)
        .map_err(TranscriptReadError::from)?
        != Some(sequence)
    {
        return Ok(None);
    }
    let head = head.expect("a session holding a readable row has a head");
    let payload = &event.payload;
    let prose = prose_body_of(event.event_type.0.as_str(), payload);
    // No text is loaded here: only the pieces a part needs are read below.
    let members = rows_of
        .row_members(&[sequence], head, -1)
        .map_err(TranscriptReadError::from)?
        .remove(&sequence)
        .unwrap_or_default();
    let piece_bounds: Vec<(i64, usize)> = members
        .iter()
        .map(|member| {
            let length =
                usize::try_from(member.content_length).expect("a piece's length fits memory");
            (member.sequence, length)
        })
        .collect();
    let last_piece = members.last().map(|member| member.sequence);
    let Some(joined) = joined_body_of(members) else {
        return Ok(Some(stored_body_content_of(
            Some(payload),
            None,
            offset,
            BodyBlockCut::NotCut,
        )?));
    };
    let body_length: usize = piece_bounds.iter().map(|(_, length)| length).sum();
    let cut_key = BlockCutKey {
        session_id: *session_id,
        sequence,
        body_length,
    };
    let kept_cut = prose.and_then(|_| kept_block_cut(&cut_key));
    let part = if let Some(prose) = prose.filter(|_| kept_cut.is_none()) {
        let all_sequences: Vec<i64> = piece_bounds.iter().map(|(sequence, _)| *sequence).collect();
        let whole = rows_of
            .piece_texts(&all_sequences)
            .map_err(TranscriptReadError::from)?;
        let pending: Vec<(i64, i64)> = last_piece
            .map(|last_piece| (sequence, last_piece))
            .into_iter()
            .collect();
        // A reply still arriving is cut as the stream seeds it, so no start it sends moves.
        let is_final = rows_of
            .unended_rows(&pending, head)
            .map_err(TranscriptReadError::from)?
            .is_empty();
        let starts;
        let block_cut = if prose.admits(&whole) {
            match body_block_starts(&whole, is_final, parse) {
                Ok(cut) => {
                    starts = cut;
                    if is_final {
                        keep_block_cut(cut_key, EndedBlockCut::Starts(starts.as_slice().into()));
                    }
                    BodyBlockCut::Starts(&starts)
                }
                Err(error) => BodyBlockCut::Failed(error.logged()),
            }
        } else {
            if is_final {
                keep_block_cut(cut_key, EndedBlockCut::NotCut);
            }
            BodyBlockCut::NotCut
        };
        stored_body_content_of(
            Some(&joined.facts()),
            Some(BodyWindow::whole(&whole)),
            offset,
            block_cut,
        )?
    } else {
        let (text, window_start) = read_part_window(&rows_of, &piece_bounds, offset)?;
        stored_body_content_of(
            Some(&joined.facts()),
            Some(BodyWindow {
                text: &text,
                start: window_start.unwrap_or(body_length),
                body_length,
            }),
            offset,
            kept_cut
                .as_ref()
                .map_or(BodyBlockCut::NotCut, EndedBlockCut::as_block_cut),
        )?
    };
    snapshot.commit().map_err(TranscriptReadError::from)?;
    Ok(Some(part))
}

// The text of the stored pieces, each `(sequence, length)` of `piece_bounds` in order, that the
// part from `offset` falls in, with where it starts in the body; `None` when no piece holds it.
// One part holds at most a page of text, so the stretches from the piece holding `offset` through
// a page past it hold the whole part.
fn read_part_window<DamagedFrom>(
    rows_of: &RowReads<'_, '_, DamagedFrom>,
    piece_bounds: &[(i64, usize)],
    offset: u64,
) -> Result<(String, Option<usize>), TranscriptReadError>
where
    DamagedFrom: Fn(&SessionId) -> Option<i64>,
{
    let wanted_from = usize::try_from(offset).unwrap_or(usize::MAX);
    let wanted_to = wanted_from.saturating_add(PAGE_MAX_BYTES);
    let mut window_start = None;
    let mut text = String::new();
    let mut piece_start = 0;
    for &(piece_sequence, length) in piece_bounds {
        let piece_end = piece_start + length;
        if piece_end > wanted_from && piece_start < wanted_to {
            let stretch = rows_of.piece_stretch(
                piece_sequence,
                wanted_from.saturating_sub(piece_start),
                wanted_to - piece_start,
            )?;
            if let Some(stretch) = stretch {
                window_start.get_or_insert(piece_start + stretch.start);
                text.push_str(&stretch.text);
            }
        }
        piece_start = piece_end;
    }
    Ok((text, window_start))
}

#[cfg(test)]
mod tests;
