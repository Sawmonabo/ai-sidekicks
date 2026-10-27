//! A reply or reasoning the provider sent in pieces, and a tool completion stored in parts of its
//! patched files, read back as one row. The insert stamps each piece or part that continues a row
//! with the sequence of the row's first piece, so a read takes only the events that stand as rows
//! and joins each row's later pieces into its body through the head it read. A row whose first
//! piece lies in a range the session skipped stands at its first readable piece. A body's size is
//! the sum of the lengths its pieces' payloads state, so a large one is never loaded to size it. A
//! row stops taking pieces at its run's turn end or rollback, one set of events for the join and
//! the end alike.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use rusqlite::{Connection, OptionalExtension, named_params};
use serde_json::{Map, Value};
use sidekicks_contracts::event::declared_variants::CONTENT_LENGTH_PAYLOAD_KEY;
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::content::{
    StoredRowBody, TranscriptRowContent, transcript_row_content_of,
};
use sidekicks_contracts::transcript::turn_attribution::TURN_END_EVENT_TYPES;
use sidekicks_contracts::wire::integer::SafeInt;

use crate::database::sql_list::sql_list_of;
use crate::events::content::codec::{
    DecodedStretch, StoredBodyColumns, stored_body_columns_sql, stored_body_encoding_sql,
    stored_body_length_sql,
};
use crate::events::session::read::{
    SELECTED_COLUMNS, SessionEventReads, SessionLogReadError, payload_damage_of, readable_event_sql,
};
use crate::events::session::skipped_ranges::outside_skipped_ranges_sql;

// The event types after which no later piece joins a run's row, so its row has ended: a turn's
// end and the run's rollback. The run's own end is not one: a run the daemon ends keeps taking its
// open turn's last text until the provider ends that turn.
static ROW_ENDING_EVENT_TYPES: LazyLock<Vec<&'static str>> = LazyLock::new(|| {
    TURN_END_EVENT_TYPES
        .into_iter()
        .chain([SessionEventType::AgentRunRolledBack.as_str()])
        .collect()
});

/// The event types that end a run's rows, as a SQL list of quoted words.
pub(crate) static ROW_ENDING_EVENT_TYPES_SQL: LazyLock<String> =
    LazyLock::new(|| sql_list_of(ROW_ENDING_EVENT_TYPES.iter().copied()));

/// Whether an event of `event_type` ends its run's rows, as [`ROW_ENDING_EVENT_TYPES_SQL`] lists.
pub fn is_row_ending_event_type(event_type: &str) -> bool {
    ROW_ENDING_EVENT_TYPES.contains(&event_type)
}

/// Whether the event aliased `event_alias` is a stored part of a patch-bearing completion, which
/// joins the completion's row and is no event of its own.
pub fn stored_patch_part_sql(event_alias: &str) -> String {
    format!("{event_alias}.patch_file_index IS NOT NULL")
}

/// Whether the event aliased `event_alias` stands as a row: it starts one, or it is a piece that
/// continues a row whose first piece is unreadable and no readable piece of that row comes before
/// it; a stored part of a completion never stands as a row of its own.
pub fn row_condition_sql(event_alias: &str) -> String {
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
// readable piece of its row, each with the length and encoding its payload states, and its stored
// body when the row's whole body is no longer than `@load_max_bytes`.
static ROW_MEMBERS_SQL: LazyLock<String> = LazyLock::new(|| {
    let member_columns = format!(
        "event.sequence, event.content_payload, {}, {}",
        stored_body_encoding_sql("event"),
        stored_body_length_sql("event"),
    );
    format!(
        "WITH row_anchor(row_sequence, anchor_sequence) AS (
         SELECT sequence, coalesce(joins_sequence, sequence) FROM session_events
          WHERE session_id = @session_id AND sequence IN (SELECT value FROM json_each(@rows))
       ),
       member(row_sequence, sequence, content_payload, content_encoding, content_length) AS (
         SELECT row_anchor.row_sequence, {member_columns}
           FROM row_anchor
           JOIN session_events AS event
             ON event.session_id = @session_id AND event.sequence = row_anchor.row_sequence
         UNION ALL
         SELECT row_anchor.row_sequence, {member_columns}
           FROM row_anchor
           JOIN session_events AS event
             ON event.session_id = @session_id
            AND event.joins_sequence = row_anchor.anchor_sequence
            AND event.sequence > row_anchor.row_sequence
          WHERE event.sequence <= @head AND {readable}
       )
     SELECT row_sequence, sequence,
            CASE WHEN sum(content_length) OVER (PARTITION BY row_sequence) <= @load_max_bytes
                 THEN content_payload END,
            content_encoding, content_length
       FROM member
      WHERE content_payload IS NOT NULL
      ORDER BY row_sequence, sequence",
        readable = readable_event_sql("event"),
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

// The stored bodies of the pieces at the given sequences, in log order.
static PIECE_TEXTS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {} FROM session_events AS event
  WHERE event.session_id = @session_id AND event.content_payload IS NOT NULL
    AND event.sequence IN (SELECT value FROM json_each(@sequences))
  ORDER BY event.sequence",
        stored_body_columns_sql("event"),
    )
});

// The stored body of the piece at one sequence.
static PIECE_BODY_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {} FROM session_events AS event
  WHERE event.session_id = @session_id AND event.sequence = @sequence",
        stored_body_columns_sql("event"),
    )
});

/// One stored piece of a row's body.
#[derive(Clone, Debug)]
pub struct RowMember {
    /// The piece's sequence.
    pub sequence: i64,
    /// Its body's UTF-8 length, as its payload states it.
    pub content_length: u64,
    /// Its text, when the read loaded it.
    pub text: Option<String>,
}

/// The rows of one session's log on a read-only connection, and the pieces their bodies join;
/// each read fails with [`SessionLogReadError`] as the log's reads do.
pub struct RowReads<'reads, 'reader, DamagedFrom> {
    reads: &'reads SessionEventReads<'reader, DamagedFrom>,
    reader: &'reader Connection,
    session_id: &'reads SessionId,
}

impl<'reads, 'reader, DamagedFrom> RowReads<'reads, 'reader, DamagedFrom>
where
    DamagedFrom: Fn(&SessionId) -> Option<i64>,
{
    /// The row reads of `session_id` over `reads`, on `reader`, the connection under `reads`.
    pub fn new(
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

    /// Up to `limit` rows of the session after `after_position`, below `before_sequence` where
    /// given.
    pub fn rows_after(
        &self,
        after_position: i64,
        before_sequence: Option<i64>,
        limit: i64,
    ) -> Result<Vec<EventEnvelope>, SessionLogReadError> {
        self.reads.read_envelopes(
            &ROWS_AFTER_SQL,
            named_params! {
                "@session_id": self.session_id.text().as_str(),
                "@after_position": after_position,
                "@read_bound": self.reads.read_bound(self.session_id, before_sequence),
                "@limit": limit,
            },
        )
    }

    /// The newest `limit` rows of the session at or below `position`, oldest first.
    pub fn rows_at_or_before(
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
    pub fn row_at(&self, position: i64) -> rusqlite::Result<Option<i64>> {
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
    /// piece's text is loaded and decoded only when its row's whole body is at most
    /// `load_max_bytes` long. Fails on a piece whose payload states no length or whose body does
    /// not decode to it, and on a payload no JSON function reads, as [`payload_damage_of`] names
    /// it.
    pub fn row_members(
        &self,
        row_sequences: &[i64],
        head: i64,
        load_max_bytes: i64,
    ) -> rusqlite::Result<HashMap<i64, Vec<RowMember>>> {
        let read = || {
            let mut members: HashMap<i64, Vec<RowMember>> = HashMap::new();
            let mut statement = self.reader.prepare_cached(&ROW_MEMBERS_SQL)?;
            let mut rows = statement.query(named_params! {
                "@session_id": self.session_id.text().as_str(),
                "@rows": serde_json::to_string(row_sequences)
                    .expect("a list of integers serializes"),
                "@head": head,
                "@read_bound": self.reads.read_bound(self.session_id, None),
                "@load_max_bytes": load_max_bytes,
            })?;
            while let Some(row) = rows.next()? {
                let body = StoredBodyColumns::read(row, 2)?;
                let content_length = body.stated_length(2)?;
                members.entry(row.get(0)?).or_default().push(RowMember {
                    sequence: row.get(1)?,
                    content_length,
                    text: body.decode(2)?,
                });
            }
            Ok(members)
        };
        read().map_err(|error| payload_damage_of(self.reader, self.session_id, error))
    }

    /// Which of `rows`, each a row's sequence and its last piece's through `head`, still take
    /// pieces: a row of a run that no turn end or rollback of its run has followed.
    pub fn unended_rows(&self, rows: &[(i64, i64)], head: i64) -> rusqlite::Result<HashSet<i64>> {
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

    /// The text of the pieces at `sequences`, decoded and joined in log order; fails on a body
    /// that does not decode to the length its payload states, and on a payload no JSON function
    /// reads, as [`payload_damage_of`] names it.
    pub fn piece_texts(&self, sequences: &[i64]) -> rusqlite::Result<String> {
        let read = || {
            let mut statement = self.reader.prepare_cached(&PIECE_TEXTS_SQL)?;
            let mut rows = statement.query(named_params! {
                "@session_id": self.session_id.text().as_str(),
                "@sequences": serde_json::to_string(sequences)
                    .expect("a list of integers serializes"),
            })?;
            let mut text = String::new();
            while let Some(row) = rows.next()? {
                if let Some(piece) = StoredBodyColumns::read(row, 0)?.decode(0)? {
                    text.push_str(&piece);
                }
            }
            Ok(text)
        };
        read().map_err(|error| payload_damage_of(self.reader, self.session_id, error))
    }

    /// The stretch covering `from..to` of the body of the piece at `sequence`, decoding only the
    /// frames it falls in; `None` when the piece has no body. Fails as [`RowReads::piece_texts`]
    /// does.
    pub fn piece_stretch(
        &self,
        sequence: i64,
        from: usize,
        to: usize,
    ) -> rusqlite::Result<Option<DecodedStretch>> {
        self.reader
            .prepare_cached(&PIECE_BODY_SQL)?
            .query_row(
                named_params! {
                    "@session_id": self.session_id.text().as_str(),
                    "@sequence": sequence,
                },
                |row| StoredBodyColumns::read(row, 0)?.decode_stretch(0, from, to),
            )
            .optional()
            .map(Option::flatten)
            .map_err(|error| payload_damage_of(self.reader, self.session_id, error))
    }
}

/// A row's body joined from its pieces: the whole body's length, and its text when every piece's
/// text was loaded.
pub struct JoinedBody {
    /// The whole body's UTF-8 length.
    pub(crate) content_length: u64,
    /// The whole text, when loaded.
    pub(crate) text: Option<String>,
}

impl JoinedBody {
    /// The payload members that describe the whole body, which a read echoes.
    pub fn facts(&self) -> Map<String, Value> {
        Map::from_iter([(
            CONTENT_LENGTH_PAYLOAD_KEY.to_owned(),
            Value::from(self.content_length),
        )])
    }
}

/// A row's body from its `members`; `None` when the row has no body.
pub fn joined_body_of(members: Vec<RowMember>) -> Option<JoinedBody> {
    if members.is_empty() {
        return None;
    }
    let mut content_length = 0;
    let mut text = Some(String::new());
    for member in members {
        content_length += member.content_length;
        text = text.zip(member.text).map(|(mut joined, piece)| {
            joined.push_str(&piece);
            joined
        });
    }
    Some(JoinedBody {
        content_length,
        text,
    })
}

/// The body a row carries: its joined text when it is loaded and small enough to travel, else its
/// size alone, else `absent`.
pub fn joined_row_content_of(
    payload: &Map<String, Value>,
    body: Option<&JoinedBody>,
) -> TranscriptRowContent {
    let Some(body) = body else {
        return transcript_row_content_of(Some(payload), None);
    };
    transcript_row_content_of(
        Some(&body.facts()),
        Some(StoredRowBody {
            byte_length: SafeInt::new(body.content_length)
                .expect("a body's length is a safe integer"),
            body: body.text.as_deref(),
        }),
    )
}
