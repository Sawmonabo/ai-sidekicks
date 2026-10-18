//! The stored row `transcript.body.read` opens: one event of one session by its id, with the body
//! its `content_payload` column holds, read whole only when a client asks for it.

use rusqlite::Connection;
use sidekicks_contracts::session::id::SessionId;

use crate::events::content::read::StoredEventContentRow;
use crate::events::session::read::SessionEventReads;
use crate::transcript::window::{TranscriptReadError, read_transcript_head};

/// The stored row of the event `event_id` of `session_id`, read on `reader`, or `None` when the
/// session reads none; `read_damaged_from_sequence` answers where a damaged session's reads stop.
/// Fails with [`TranscriptReadError::Refused`] (`session.notFound`) for a session this daemon
/// holds no events for, and with [`TranscriptReadError::Log`] when the read fails.
pub(crate) fn read_stored_event_row<DamagedFrom>(
    reader: &Connection,
    read_damaged_from_sequence: &DamagedFrom,
    session_id: &SessionId,
    event_id: &str,
) -> Result<Option<StoredEventContentRow>, TranscriptReadError>
where
    DamagedFrom: Fn(&SessionId) -> Option<i64> + ?Sized,
{
    let reads = SessionEventReads::new(reader, read_damaged_from_sequence);
    let stored_row = reads.read_stored_row(session_id, event_id)?;
    if stored_row.is_none() {
        // Tells a session this daemon lacks from a row its session lacks.
        read_transcript_head(&reads, read_damaged_from_sequence, session_id)?;
    }
    Ok(stored_row)
}
