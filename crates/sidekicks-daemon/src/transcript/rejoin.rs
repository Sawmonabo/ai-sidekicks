//! A reply or reasoning the provider sent in pieces, and a tool completion stored in parts of its
//! patched files, read back as one row. The insert stamps each piece or part that continues a row
//! with the sequence of the row's first piece, so a read takes only the events that stand as rows
//! and joins each row's later pieces into its body through the head it read. A row whose first
//! piece lies in a range the session skipped stands at its first readable piece. A body's size is
//! the sum of its pieces' own lengths, so a large one is never loaded. A row stops taking pieces at
//! its run's turn end, end or rollback, one set of events for the join and the end alike.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use rusqlite::{Connection, OptionalExtension, named_params};
use serde_json::{Map, Value};
use sidekicks_contracts::event::declared_variants::{
    CONTENT_LENGTH_PAYLOAD_KEY, CONTENT_TRUNCATED_PAYLOAD_KEY,
};
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::content::{
    StoredRowBody, TranscriptRowContent, transcript_row_content_of,
};
use sidekicks_contracts::transcript::turn_attribution::TURN_END_EVENT_TYPES;
use sidekicks_contracts::wire::integer::SafeInt;

use crate::database::sql_list::sql_list_of;
use crate::database::stored_column::optional_utf8_blob_column;
use crate::events::session::read::{
    SELECTED_COLUMNS, SessionEventReads, SessionLogReadError, readable_event_sql,
};
use crate::events::session::skipped_ranges::outside_skipped_ranges_sql;
use crate::session::run::transitions::{RUN_TERMINAL_EVENT_TYPES_SQL, is_run_terminal_event_type};

/// The event types after which no later piece joins a run's row, so its row has ended: a turn's
/// end, the run's end and its rollback, as a SQL list of quoted words.
pub(crate) static ROW_ENDING_EVENT_TYPES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{}, {}, '{}'",
        sql_list_of(TURN_END_EVENT_TYPES),
        *RUN_TERMINAL_EVENT_TYPES_SQL,
        SessionEventType::AgentRunRolledBack.as_str(),
    )
});

/// Whether an event of `event_type` ends its run's rows, as [`ROW_ENDING_EVENT_TYPES_SQL`] lists.
pub(crate) fn is_row_ending_event_type(event_type: &str) -> bool {
    TURN_END_EVENT_TYPES.contains(&event_type)
        || is_run_terminal_event_type(event_type)
        || event_type == SessionEventType::AgentRunRolledBack.as_str()
}

/// Whether the event aliased `event_alias` is a stored part of a patch-bearing completion, which
/// joins the completion's row and is no event of its own.
pub(crate) fn stored_patch_part_sql(event_alias: &str) -> String {
    format!("{event_alias}.patch_file_index IS NOT NULL")
}

/// Whether the event aliased `event_alias` stands as a row: it starts one, or it is a piece that
/// continues a row whose first piece is unreadable and no readable piece of that row comes before
/// it; a stored part of a completion never stands as a row of its own.
pub(crate) fn row_condition_sql(event_alias: &str) -> String {
    format!(
        "({event_alias}.joins_sequence IS NULL OR (
      {event_alias}.patch_file_index IS NULL
      AND NOT EXISTS (SELECT 1 FROM session_events AS anchor
                   WHERE anchor.session_id = {event_alias}.session_id
                     AND anchor.sequence = {event_alias}.joins_sequence
                     AND {})
      AND NOT EXISTS (SELECT 1 FROM session_events AS earlier
                       WHERE earlier.session_id = {event_alias}.session_id
                         AND earlier.joins_sequence = {event_alias}.joins_sequence
                         AND earlier.sequence < {event_alias}.sequence
                         AND {})))",
        outside_skipped_ranges_sql("anchor"),
        outside_skipped_ranges_sql("earlier"),
    )
}

static ROWS_AFTER_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {SELECTED_COLUMNS} FROM session_events AS event
      WHERE event.session_id = @session_id AND event.sequence > @after_position
        AND {} AND {}
      ORDER BY event.sequence ASC
      LIMIT @limit",
        readable_event_sql("event"),
        row_condition_sql("event"),
    )
});

// Newest first so the limit keeps the rows nearest the position; the read reverses them.
static ROWS_AT_OR_BEFORE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {SELECTED_COLUMNS} FROM session_events AS event
      WHERE event.session_id = @session_id AND event.sequence <= @position
        AND {} AND {}
      ORDER BY event.sequence DESC
      LIMIT @limit",
        readable_event_sql("event"),
        row_condition_sql("event"),
    )
});

// A run's rows: its own events, the events filed under it, and its children's creation rows, each
// a search of its own index, merged in log order.
static RUN_ROWS_AFTER_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {SELECTED_COLUMNS} FROM (
         SELECT * FROM session_events
          WHERE session_id = @session_id AND run_id = @run_id AND sequence > @after_position
         UNION ALL
         SELECT * FROM session_events
          WHERE session_id = @session_id AND target_run_id = @run_id
            AND sequence > @after_position
         UNION ALL
         SELECT * FROM session_events
          WHERE session_id = @session_id AND type = '{}' AND sequence > @after_position
            AND run_id IN (SELECT run_id FROM runs WHERE parent_run_id = @run_id)
       ) AS event
      WHERE {} AND {}
      ORDER BY event.sequence ASC
      LIMIT @limit",
        SessionEventType::AgentRunQueued.as_str(),
        readable_event_sql("event"),
        row_condition_sql("event"),
    )
});

static POSITION_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT event.joins_sequence, {} FROM session_events AS event
      WHERE event.session_id = @session_id AND event.sequence = @position AND {}",
        row_condition_sql("event"),
        readable_event_sql("event"),
    )
});

// The first readable event of the row whose first piece sits at `@anchor_sequence`.
static ROW_OF_ANCHOR_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT min(event.sequence) FROM session_events AS event
      WHERE event.session_id = @session_id
        AND (event.sequence = @anchor_sequence OR event.joins_sequence = @anchor_sequence)
        AND {}",
        readable_event_sql("event"),
    )
});

// Each row's body pieces through the head, in order: the row's own event, then every later
// readable piece of its row, each with its stored size, the length and cut mark its payload states,
// and its text when the row's whole body is no larger than `@load_max_bytes`.
static ROW_MEMBERS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "WITH row_anchor(row_sequence, anchor_sequence) AS (
         SELECT sequence, coalesce(joins_sequence, sequence) FROM session_events
          WHERE session_id = @session_id AND sequence IN (SELECT value FROM json_each(@rows))
       ),
       member(row_sequence, sequence, content_payload, payload) AS (
         SELECT row_anchor.row_sequence, event.sequence, event.content_payload, NULL
           FROM row_anchor
           JOIN session_events AS event
             ON event.session_id = @session_id AND event.sequence = row_anchor.row_sequence
         UNION ALL
         SELECT row_anchor.row_sequence, event.sequence, event.content_payload, event.payload
           FROM row_anchor
           JOIN session_events AS event
             ON event.session_id = @session_id
            AND event.joins_sequence = row_anchor.anchor_sequence
            AND event.sequence > row_anchor.row_sequence
          WHERE event.sequence <= @head AND {}
       )
     SELECT row_sequence, sequence, octet_length(content_payload),
            json_extract(payload, '$.{CONTENT_LENGTH_PAYLOAD_KEY}'),
            coalesce(json_extract(payload, '$.{CONTENT_TRUNCATED_PAYLOAD_KEY}'), 0),
            CASE WHEN sum(octet_length(content_payload)) OVER (PARTITION BY row_sequence)
                      <= @load_max_bytes
                 THEN content_payload END
       FROM member
      WHERE content_payload IS NOT NULL
      ORDER BY row_sequence, sequence",
        readable_event_sql("event"),
    )
});

// The rows of a run, each given as its sequence and its last piece's, that nothing has ended
// through the head: no event ending its run's rows after its last piece, the same events that
// close the join a later piece takes. Each probe is one search of an index, so a long row costs no
// more than a short one.
static UNENDED_ROWS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT row.sequence
       FROM json_each(@rows) AS given
       JOIN session_events AS row
         ON row.session_id = @session_id AND row.sequence = json_extract(given.value, '$[0]')
      WHERE row.run_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM session_events AS ended
           WHERE ended.session_id = @session_id AND ended.type IN ({row_ends})
             AND ended.run_id = row.run_id
             AND ended.sequence > json_extract(given.value, '$[1]') AND ended.sequence <= @head
             AND {readable_ended})",
        row_ends = *ROW_ENDING_EVENT_TYPES_SQL,
        readable_ended = readable_event_sql("ended"),
    )
});

// The stored text of the pieces at the given sequences, in log order.
const PIECE_TEXTS_SQL: &str = "SELECT content_payload FROM session_events
  WHERE session_id = @session_id AND content_payload IS NOT NULL
    AND sequence IN (SELECT value FROM json_each(@sequences))
  ORDER BY sequence";

/// Which rows a read takes: the whole session's, or one run's with its children's creation rows.
#[derive(Clone, Copy, Debug)]
pub(crate) enum RowScope<'run> {
    /// Every row of the session.
    Session,
    /// The run's own rows, the rows filed under it, and its children's creation rows.
    Run(&'run RunId),
}

/// One stored piece of a row's body.
#[derive(Clone, Debug)]
pub(crate) struct RowMember {
    /// The piece's sequence.
    pub(crate) sequence: i64,
    /// Its stored body's UTF-8 size.
    pub(crate) byte_length: u64,
    /// The length its payload states, read for every piece but the row's own event, whose payload
    /// the row already holds.
    pub(crate) content_length: Option<u64>,
    /// Whether its payload marks its body as cut.
    pub(crate) is_truncated: bool,
    /// Its text, when the read loaded it.
    pub(crate) text: Option<String>,
}

/// The rows of one session's log on a read-only connection, and the pieces their bodies join;
/// each read fails with [`SessionLogReadError`] as the log's reads do.
pub(crate) struct RowReads<'reads, 'reader, DamagedFrom> {
    reads: &'reads SessionEventReads<'reader, DamagedFrom>,
    reader: &'reader Connection,
    session_id: &'reads SessionId,
}

impl<'reads, 'reader, DamagedFrom> RowReads<'reads, 'reader, DamagedFrom>
where
    DamagedFrom: Fn(&SessionId) -> Option<i64>,
{
    /// The row reads of `session_id` over `reads`, on `reader`, the connection `reads` runs on.
    pub(crate) fn new(
        reads: &'reads SessionEventReads<'reader, DamagedFrom>,
        reader: &'reader Connection,
        session_id: &'reads SessionId,
    ) -> Self {
        Self {
            reads,
            reader,
            session_id,
        }
    }

    /// Up to `limit` rows of `scope` after `after_position`, below `before_sequence` where given.
    pub(crate) fn rows_after(
        &self,
        scope: RowScope<'_>,
        after_position: i64,
        before_sequence: Option<i64>,
        limit: i64,
    ) -> Result<Vec<EventEnvelope>, SessionLogReadError> {
        let read_bound = self.reads.read_bound(self.session_id, before_sequence);
        let session_id = self.session_id.text();
        match scope {
            RowScope::Session => self.reads.read_envelopes(
                &ROWS_AFTER_SQL,
                named_params! {
                    "@session_id": session_id.as_str(),
                    "@after_position": after_position,
                    "@read_bound": read_bound,
                    "@limit": limit,
                },
            ),
            RowScope::Run(run_id) => self.reads.read_envelopes(
                &RUN_ROWS_AFTER_SQL,
                named_params! {
                    "@session_id": session_id.as_str(),
                    "@run_id": run_id.text().as_str(),
                    "@after_position": after_position,
                    "@read_bound": read_bound,
                    "@limit": limit,
                },
            ),
        }
    }

    /// The newest `limit` rows of the session at or below `position`, oldest first.
    pub(crate) fn rows_at_or_before(
        &self,
        position: i64,
        limit: i64,
    ) -> Result<Vec<EventEnvelope>, SessionLogReadError> {
        let mut rows = self.reads.read_envelopes(
            &ROWS_AT_OR_BEFORE_SQL,
            named_params! {
                "@session_id": self.session_id.text().as_str(),
                "@position": position,
                "@read_bound": self.reads.read_bound(self.session_id, None),
                "@limit": limit,
            },
        )?;
        rows.reverse();
        Ok(rows)
    }

    /// The sequence of the row the readable event at `position` belongs to: its own when it stands
    /// as a row, else its row's; `None` when no readable event sits there.
    pub(crate) fn row_at(&self, position: i64) -> rusqlite::Result<Option<i64>> {
        let session_id = self.session_id.text();
        let read_bound = self.reads.read_bound(self.session_id, None);
        let found: Option<(Option<i64>, bool)> = self
            .reader
            .prepare_cached(&POSITION_SQL)?
            .query_row(
                named_params! {
                    "@session_id": session_id.as_str(),
                    "@position": position,
                    "@read_bound": read_bound,
                },
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((joins_sequence, is_row)) = found else {
            return Ok(None);
        };
        let Some(anchor_sequence) = joins_sequence.filter(|_| !is_row) else {
            return Ok(Some(position));
        };
        self.reader.prepare_cached(&ROW_OF_ANCHOR_SQL)?.query_row(
            named_params! {
                "@session_id": session_id.as_str(),
                "@anchor_sequence": anchor_sequence,
                "@read_bound": read_bound,
            },
            |row| row.get(0),
        )
    }

    /// The body pieces of each row in `row_sequences` through `head`, by row, in order; each
    /// piece's text is loaded only when its row's whole stored body is at most `load_max_bytes`.
    pub(crate) fn row_members(
        &self,
        row_sequences: &[i64],
        head: i64,
        load_max_bytes: i64,
    ) -> rusqlite::Result<HashMap<i64, Vec<RowMember>>> {
        let mut members: HashMap<i64, Vec<RowMember>> = HashMap::new();
        let mut statement = self.reader.prepare_cached(&ROW_MEMBERS_SQL)?;
        let mut rows = statement.query(named_params! {
            "@session_id": self.session_id.text().as_str(),
            "@rows": serde_json::to_string(row_sequences).expect("a list of integers serializes"),
            "@head": head,
            "@read_bound": self.reads.read_bound(self.session_id, None),
            "@load_max_bytes": load_max_bytes,
        })?;
        while let Some(row) = rows.next()? {
            let byte_length: i64 = row.get(2)?;
            let content_length: Option<i64> = row.get(3)?;
            let is_truncated: bool = row.get(4)?;
            members.entry(row.get(0)?).or_default().push(RowMember {
                sequence: row.get(1)?,
                byte_length: u64::try_from(byte_length).unwrap_or_default(),
                content_length: content_length.and_then(|length| u64::try_from(length).ok()),
                is_truncated,
                text: optional_utf8_blob_column(row, 5)?,
            });
        }
        Ok(members)
    }

    /// Which of `rows`, each a row's sequence and its last piece's through `head`, still take
    /// pieces: a row of a run that no turn end, end or rollback of its run has followed.
    pub(crate) fn unended_rows(
        &self,
        rows: &[(i64, i64)],
        head: i64,
    ) -> rusqlite::Result<HashSet<i64>> {
        if rows.is_empty() {
            return Ok(HashSet::new());
        }
        self.reader
            .prepare_cached(&UNENDED_ROWS_SQL)?
            .query_map(
                named_params! {
                    "@session_id": self.session_id.text().as_str(),
                    "@rows": serde_json::to_string(rows).expect("pairs of integers serialize"),
                    "@head": head,
                    "@read_bound": self.reads.read_bound(self.session_id, None),
                },
                |row| row.get(0),
            )?
            .collect()
    }

    /// The stored text of the pieces at `sequences`, joined in log order.
    pub(crate) fn piece_texts(&self, sequences: &[i64]) -> rusqlite::Result<String> {
        let mut statement = self.reader.prepare_cached(PIECE_TEXTS_SQL)?;
        let mut rows = statement.query(named_params! {
            "@session_id": self.session_id.text().as_str(),
            "@sequences": serde_json::to_string(sequences).expect("a list of integers serializes"),
        })?;
        let mut text = String::new();
        while let Some(row) = rows.next()? {
            if let Some(piece) = optional_utf8_blob_column(row, 0)? {
                text.push_str(&piece);
            }
        }
        Ok(text)
    }
}

/// A row's body facts and text, joined from its pieces: the payload to echo its length and cut
/// mark from, which is the row event's own when the row is one piece, and the text, when every
/// piece's text was loaded.
pub(crate) struct JoinedBody {
    /// The payload whose `contentLength` and `contentTruncated` describe the whole body.
    pub(crate) facts: Map<String, Value>,
    /// The body's stored UTF-8 size.
    pub(crate) byte_length: u64,
    /// The whole text, when loaded.
    pub(crate) text: Option<String>,
}

/// The body of the row at `row_sequence` whose event carries `payload`, from its `members`;
/// `None` when the row has no body.
pub(crate) fn joined_body_of(
    row_sequence: i64,
    payload: &Map<String, Value>,
    members: Vec<RowMember>,
) -> Option<JoinedBody> {
    let is_one_piece = members.len() == 1 && members[0].sequence == row_sequence;
    if is_one_piece {
        let member = members.into_iter().next().expect("one piece");
        return Some(JoinedBody {
            facts: payload.clone(),
            byte_length: member.byte_length,
            text: member.text,
        });
    }
    if members.is_empty() {
        return None;
    }
    let (row_content_length, row_is_truncated) = echoed_facts_of(payload);
    let mut facts = Map::new();
    let mut content_length = 0;
    let mut byte_length = 0;
    let mut is_truncated = false;
    let mut text = Some(String::new());
    for member in members {
        let (member_length, member_is_truncated) = if member.sequence == row_sequence {
            (row_content_length, row_is_truncated)
        } else {
            (member.content_length, member.is_truncated)
        };
        content_length += member_length.unwrap_or(member.byte_length);
        byte_length += member.byte_length;
        is_truncated |= member_is_truncated;
        text = text.zip(member.text).map(|(mut joined, piece)| {
            joined.push_str(&piece);
            joined
        });
    }
    facts.insert(CONTENT_LENGTH_PAYLOAD_KEY.to_owned(), content_length.into());
    if is_truncated {
        facts.insert(CONTENT_TRUNCATED_PAYLOAD_KEY.to_owned(), Value::Bool(true));
    }
    Some(JoinedBody {
        facts,
        byte_length,
        text,
    })
}

/// The body a row carries: its joined text when it is loaded and small enough to travel, else its
/// size alone, else `absent`.
pub(crate) fn joined_row_content_of(
    payload: &Map<String, Value>,
    body: Option<&JoinedBody>,
) -> TranscriptRowContent {
    let Some(body) = body else {
        return transcript_row_content_of(Some(payload), None);
    };
    transcript_row_content_of(
        Some(&body.facts),
        Some(StoredRowBody {
            byte_length: SafeInt::new(body.byte_length).expect("a body's size is a safe integer"),
            body: body.text.as_deref(),
        }),
    )
}

/// The length and cut mark `payload` states for its own body.
fn echoed_facts_of(payload: &Map<String, Value>) -> (Option<u64>, bool) {
    (
        payload
            .get(CONTENT_LENGTH_PAYLOAD_KEY)
            .and_then(Value::as_u64),
        payload
            .get(CONTENT_TRUNCATED_PAYLOAD_KEY)
            .and_then(Value::as_bool)
            .unwrap_or(false),
    )
}
