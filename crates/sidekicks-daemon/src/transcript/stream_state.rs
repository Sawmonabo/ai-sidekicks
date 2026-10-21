//! What a session stream keeps between frames so each change says what its transcript row needs:
//! for every row still taking pieces, its id and where its next piece starts, and for every child
//! run the stream met, its running event count. A stream that first meets a row or a child partway
//! seeds it with one indexed read; a row is let go at its run's turn end, a child at its end.

use std::collections::HashMap;
use std::sync::LazyLock;

use rusqlite::{Connection, OptionalExtension, named_params};
use serde_json::{Map, Value};
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionStreamPiece;
use sidekicks_contracts::transcript::child_run_summary::{
    ChildRunCompleteness, ChildRunIncompleteCause, ChildRunSummary,
};
use sidekicks_contracts::transcript::content::{
    StoredRowBody, TranscriptRowContent, transcript_row_content_of,
};
use sidekicks_contracts::transcript::run_attribution::transcript_own_run_id_of;
use sidekicks_contracts::transcript::turn_attribution::TURN_END_EVENT_TYPES;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::database::stored_column::{
    closed_word, optional_text_column, optional_utf8_blob_column, text_column,
};
use crate::events::session::read::readable_event_sql;
use crate::session::run::transitions::is_run_terminal_event_type;
use crate::transcript::child_run::read_child_counts;
use crate::transcript::projector::TRANSCRIPT_ROW_BODY_INLINE_MAX_UTF8_BYTES;

// Each page event's place in the rows: the row it continues, whether it is a piece of a reply or
// of reasoning, and its body's size, with its text when it can travel inline.
const PAGE_PIECES_SQL: &str = "SELECT sequence, joins_sequence, join_key IS NOT NULL,
       octet_length(content_payload),
       CASE WHEN octet_length(content_payload) <= @inline_max THEN content_payload END
  FROM session_events
 WHERE session_id = @session_id AND sequence IN (SELECT value FROM json_each(@sequences))";

// Where a piece first met partway through its row sits: the row's id, which is its first event's
// or, when that one cannot be read, the row's first readable piece's, and the bytes of the row's
// readable pieces before it.
static ROW_PLACE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT coalesce(
            (SELECT anchor.id FROM session_events AS anchor
              WHERE anchor.session_id = @session_id AND anchor.sequence = @anchor_sequence
                AND {readable_anchor}),
            (SELECT earlier.id FROM session_events AS earlier
              WHERE earlier.session_id = @session_id AND earlier.joins_sequence = @anchor_sequence
                AND {readable_earlier}
              ORDER BY earlier.sequence LIMIT 1)),
          coalesce((SELECT sum(octet_length(event.content_payload)) FROM session_events AS event
             WHERE event.session_id = @session_id
               AND (event.sequence = @anchor_sequence OR event.joins_sequence = @anchor_sequence)
               AND event.sequence < @sequence AND {readable_event}), 0)",
        readable_anchor = readable_event_sql("anchor"),
        readable_earlier = readable_event_sql("earlier"),
        readable_event = readable_event_sql("event"),
    )
});

const RUN_PARENT_SQL: &str = "SELECT parent_run_id FROM runs WHERE run_id = ?";

const RUN_STATE_SQL: &str = "SELECT state FROM runs WHERE run_id = ?";

/// One page event's stored facts the stream reads beside it.
#[derive(Clone, Debug)]
pub(crate) struct StreamedPiece {
    /// The sequence of the row's first piece, on a piece that continues a row.
    joins_sequence: Option<i64>,
    /// Whether the event is a piece of a run's reply or reasoning.
    is_piece: bool,
    /// Its body's UTF-8 size and its text when it can travel inline; `None` with no body.
    body: Option<(u64, Option<String>)>,
}

impl StreamedPiece {
    /// The body the change carries for `payload`'s piece: its text, or its size alone when too
    /// large to travel; `None` on an event that is not a piece.
    pub(crate) fn content_of(&self, payload: &Map<String, Value>) -> Option<TranscriptRowContent> {
        self.is_piece.then(|| {
            transcript_row_content_of(
                Some(payload),
                self.body.as_ref().map(|(byte_length, text)| StoredRowBody {
                    byte_length: SafeInt::new(*byte_length)
                        .expect("a body's size is a safe integer"),
                    body: text.as_deref(),
                }),
            )
        })
    }
}

/// Reads the stored facts of the events at `sequences` of `session_id`, on `reader`, by sequence.
pub(crate) fn read_streamed_pieces(
    reader: &Connection,
    session_id: &SessionId,
    sequences: &[i64],
) -> rusqlite::Result<HashMap<i64, StreamedPiece>> {
    let mut statement = reader.prepare_cached(PAGE_PIECES_SQL)?;
    let mut rows = statement.query(named_params! {
        "@session_id": session_id.text().as_str(),
        "@sequences": serde_json::to_string(sequences).expect("a list of integers serializes"),
        "@inline_max": TRANSCRIPT_ROW_BODY_INLINE_MAX_UTF8_BYTES,
    })?;
    let mut pieces = HashMap::new();
    while let Some(row) = rows.next()? {
        let byte_length: Option<i64> = row.get(3)?;
        let body = byte_length
            .map(|length| {
                Ok::<_, rusqlite::Error>((
                    u64::try_from(length).expect("a size is not negative"),
                    optional_utf8_blob_column(row, 4)?,
                ))
            })
            .transpose()?;
        pieces.insert(
            row.get(0)?,
            StreamedPiece {
                joins_sequence: row.get(1)?,
                is_piece: row.get(2)?,
                body,
            },
        );
    }
    Ok(pieces)
}

/// A row still taking pieces.
#[derive(Debug)]
struct OpenRow {
    run_id: RunId,
    row_id: FreeFormText<EVENT_FIELD_MAX_LEN>,
    next_offset: u64,
}

/// A child run's running count of its events.
#[derive(Debug)]
struct ChildTally {
    parent_run_id: RunId,
    state: RunState,
    total: u64,
    readable: u64,
}

/// The rows and child runs one session stream is following.
#[derive(Debug, Default)]
pub(crate) struct TranscriptStreamState {
    /// Open rows, by the sequence of their first piece.
    open_rows: HashMap<i64, OpenRow>,
    /// Every run the stream met, with its tally when it is a child.
    runs: HashMap<RunId, Option<ChildTally>>,
}

impl TranscriptStreamState {
    /// Where `event`, a piece of `run_id` with stored facts `stored` carrying `content`, sits in
    /// its row, read on `reader` when the stream meets the row partway; `read_bound` is where the
    /// session's reads stop. Fails when SQLite refuses the seed read.
    pub(crate) fn place_piece(
        &mut self,
        reader: &Connection,
        read_bound: i64,
        event: &EventEnvelope,
        run_id: RunId,
        stored: &StreamedPiece,
        content: TranscriptRowContent,
    ) -> rusqlite::Result<SessionStreamPiece> {
        let sequence = i64::from(event.sequence);
        let anchor_sequence = stored.joins_sequence.unwrap_or(sequence);
        let byte_length = stored.body.as_ref().map_or(0, |(length, _)| *length);
        let open_row = match self.open_rows.remove(&anchor_sequence) {
            Some(open_row) => open_row,
            None if stored.joins_sequence.is_none() => OpenRow {
                run_id,
                row_id: event.id.clone(),
                next_offset: 0,
            },
            None => {
                let (row_id, offset): (String, i64) =
                    reader.prepare_cached(&ROW_PLACE_SQL)?.query_row(
                        named_params! {
                            "@session_id": event.session_id.text().as_str(),
                            "@anchor_sequence": anchor_sequence,
                            "@sequence": sequence,
                            "@read_bound": read_bound,
                        },
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )?;
                OpenRow {
                    run_id,
                    row_id: FreeFormText::new(row_id).expect("a stored event id is an event id"),
                    next_offset: u64::try_from(offset).expect("a size is not negative"),
                }
            }
        };
        let piece = SessionStreamPiece {
            row_id: open_row.row_id.clone(),
            offset: SafeInt::new(open_row.next_offset).expect("an offset is a safe integer"),
            content,
            block_starts: None,
        };
        self.open_rows.insert(
            anchor_sequence,
            OpenRow {
                next_offset: open_row.next_offset + byte_length,
                ..open_row
            },
        );
        Ok(piece)
    }

    /// The summary `event`, filed under `run_id`, carries when that run is a child: its count
    /// through this event, read on `reader` when the stream first meets the child, and complete
    /// unless some of its events cannot be read, as of `observed_at`. Fails when SQLite refuses a
    /// read.
    pub(crate) fn child_run_summary(
        &mut self,
        reader: &Connection,
        read_bound: i64,
        event: &EventEnvelope,
        run_id: RunId,
        observed_at: &WireInstant,
    ) -> rusqlite::Result<Option<ChildRunSummary>> {
        let is_own_event = transcript_own_run_id_of(Some(&event.payload))
            .is_some_and(|own| own == run_id.to_string());
        let tally = if let Some(tally) = self.runs.get_mut(&run_id) {
            if let Some(tally) = tally.as_mut().filter(|_| is_own_event) {
                tally.total += 1;
                tally.readable += 1;
                tally.state = read_state(reader, &run_id)?.unwrap_or(tally.state);
            }
            tally
        } else {
            let tally = seed_child_tally(reader, read_bound, event, &run_id)?;
            self.runs.entry(run_id).or_insert(tally)
        };
        let Some(tally) = tally else {
            return Ok(None);
        };
        Ok(Some(ChildRunSummary {
            run_id,
            parent_run_id: tally.parent_run_id,
            state: tally.state,
            event_count: SafeInt::new(tally.readable).expect("an event count is a safe integer"),
            completeness: if tally.readable == tally.total {
                ChildRunCompleteness::Complete {}
            } else {
                ChildRunCompleteness::Incomplete {
                    cause: ChildRunIncompleteCause::DetailFetchFailed,
                    observed_at: observed_at.clone(),
                }
            },
        }))
    }

    /// Lets go of what `event`, filed under `run_id`, ends: the run's open rows at a turn's end or
    /// its own end, and the run itself at its end.
    pub(crate) fn forget_ended(&mut self, event: &EventEnvelope, run_id: RunId) {
        let event_type = event.event_type.0.as_str();
        let is_run_end = is_run_terminal_event_type(event_type);
        if is_run_end || TURN_END_EVENT_TYPES.contains(&event_type) {
            self.open_rows
                .retain(|_, open_row| open_row.run_id != run_id);
        }
        if is_run_end {
            self.runs.remove(&run_id);
        }
    }
}

// The child tally of `run_id` through `event`, or `None` for a run with no parent.
fn seed_child_tally(
    reader: &Connection,
    read_bound: i64,
    event: &EventEnvelope,
    run_id: &RunId,
) -> rusqlite::Result<Option<ChildTally>> {
    let parent_run_id: Option<RunId> = reader
        .prepare_cached(RUN_PARENT_SQL)?
        .query_row([run_id.text().as_str()], |row| {
            optional_text_column(row, 0, |text| RunId::new(&text))
        })
        .optional()?
        .flatten();
    let Some(parent_run_id) = parent_run_id.filter(|parent| parent != run_id) else {
        return Ok(None);
    };
    let run_key = run_id.to_string();
    let mut counts = read_child_counts(
        reader,
        &event.session_id,
        std::slice::from_ref(&run_key),
        i64::from(event.sequence),
        read_bound,
    )?;
    Ok(counts.remove(&run_key).map(|count| ChildTally {
        parent_run_id,
        state: count.state,
        total: count.total,
        readable: count.readable,
    }))
}

fn read_state(reader: &Connection, run_id: &RunId) -> rusqlite::Result<Option<RunState>> {
    reader
        .prepare_cached(RUN_STATE_SQL)?
        .query_row([run_id.text().as_str()], |row| {
            text_column(row, 0, closed_word)
        })
        .optional()
}
