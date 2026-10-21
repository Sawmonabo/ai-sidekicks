//! The text the search index holds for each source row, read from the database as it is now: a
//! settled message's text, a tool call's name and arguments, a session's title, a group's name and
//! a tag, with a tag's fold and its session's last activity beside it. The outbox applier, the
//! rebuild and the hit reader all read rows here, so a hit's line is marked on the same text the
//! index saw. A log row belongs to its session through the session's directory row; a log row of a
//! session with none, which only the daemon's own sentinel session lacks, is no index row, and
//! neither is a row in a range its session skipped past as damaged or one whose payload damage left
//! unreadable.

use std::collections::HashMap;
use std::sync::LazyLock;

use rusqlite::{Connection, Row, named_params};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_search::index::{IndexRow, IndexRowKind, IndexRowTag};

use crate::database::sql_list::sql_list_of;
use crate::database::stored_column::{optional_text_column, rowid_column};
use crate::events::content::codec::{
    StoredBodyColumns, stored_body_encoding_sql, stored_body_length_sql,
};
use crate::events::session::skipped_ranges::outside_skipped_ranges_sql;
use crate::session::search::index::columns::{index_key_sql, index_row_kind_of, source_rowid_of};

// The log rows the index holds: a person's message, an agent's message and a tool call, each
// stored once settled. A thinking update is narration a later event supersedes, so it is never
// indexed.
const INDEXED_EVENT_TYPES: [SessionEventType; 3] = [
    SessionEventType::UserMessageSent,
    SessionEventType::AgentMessageSent,
    SessionEventType::AgentToolCallInvoked,
];

/// The log rows the index holds, as a SQL list: a person's message, an agent's message and a
/// tool call, each stored once settled, never a thinking update or a streamed chunk.
pub(crate) static INDEXED_EVENT_TYPES_SQL: LazyLock<String> =
    LazyLock::new(|| sql_list_of(INDEXED_EVENT_TYPES.map(SessionEventType::as_str)));

/// The most rows one batch handed to the index carries. A durable commit costs about the same
/// whatever its size, so a batch takes as many rows as can comfortably sit in memory while one
/// apply runs.
pub(crate) const INDEX_BATCH_ROW_LIMIT: usize = 50_000;

/// The text, in UTF-8 bytes, past which a batch handed to the index takes no further rows: 16 MiB,
/// so a batch of long messages holds near that in memory while one apply runs.
pub(crate) const INDEX_BATCH_TEXT_LIMIT: usize = 16 * 1024 * 1024;

/// What one batch handed to the index may still take: rows, and text in UTF-8 bytes. Each read of
/// a batch takes what it reads from the one room, so the reads share its limits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct IndexBatchRoom {
    /// The rows the batch may still take.
    pub(crate) rows: usize,
    /// The text, in UTF-8 bytes, the batch may still take.
    pub(crate) text_bytes: usize,
}

impl IndexBatchRoom {
    // Whether the batch can take no further row.
    fn is_full(self) -> bool {
        self.rows == 0 || self.text_bytes == 0
    }
}

/// The room of a batch nothing has been read into yet.
pub(crate) fn empty_index_batch_room() -> IndexBatchRoom {
    IndexBatchRoom {
        rows: INDEX_BATCH_ROW_LIMIT,
        text_bytes: INDEX_BATCH_TEXT_LIMIT,
    }
}

/// A source row as the index holds it, and where a log row sits in its session's log.
#[derive(Clone, Debug)]
pub(crate) struct SourceRow {
    /// The row's index key.
    pub(crate) key: u64,
    /// What the row holds.
    pub(crate) kind: IndexRowKind,
    /// The session the row belongs to; for a group's name, the group.
    pub(crate) owner_key: u64,
    /// The row's text as the database holds it now.
    pub(crate) text: String,
    /// A log row's id and position in its session's log; `None` on a title, group or tag.
    pub(crate) log_row: Option<LogRowPosition>,
    /// A tag row's fold and its session's last activity; `None` on every other row.
    pub(crate) tag: Option<IndexRowTag>,
}

/// A log row's event id and its sequence in its session's log.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LogRowPosition {
    /// The event's id.
    pub(crate) event_id: String,
    /// The event's sequence in its session's log.
    pub(crate) sequence: i64,
}

// A log row's text before its body: a person's words, nothing before an agent's reply, or a tool's
// name; none for a payload that is not JSON, which `json_extract` would refuse with an error.
static EVENT_TEXT_SQL: LazyLock<String> = LazyLock::new(|| {
    let user_message = SessionEventType::UserMessageSent.as_str();
    let agent_message = SessionEventType::AgentMessageSent.as_str();
    let tool_call = SessionEventType::AgentToolCallInvoked.as_str();
    format!(
        "CASE
           WHEN NOT json_valid(event.payload) THEN NULL
           WHEN event.type = '{user_message}' THEN json_extract(event.payload, '$.message')
           WHEN event.type = '{agent_message}' AND event.content_payload IS NOT NULL THEN ''
           WHEN event.type = '{tool_call}' THEN json_extract(event.payload, '$.toolName')
         END"
    )
});

// A log row's body, which the read decodes and joins after its text: an agent's reply, or a
// tool's arguments after a space; the separator, then the stored bytes, encoding and length.
static EVENT_BODY_SQL: LazyLock<String> = LazyLock::new(|| {
    let agent_message = SessionEventType::AgentMessageSent.as_str();
    let tool_call = SessionEventType::AgentToolCallInvoked.as_str();
    format!(
        "CASE WHEN event.type = '{tool_call}' THEN ' ' ELSE '' END,
           CASE WHEN json_valid(event.payload)
                 AND event.type IN ('{agent_message}', '{tool_call}')
                THEN event.content_payload END,
           CASE WHEN json_valid(event.payload) THEN {encoding} END,
           CASE WHEN json_valid(event.payload) THEN {length} END",
        encoding = stored_body_encoding_sql("event"),
        length = stored_body_length_sql("event"),
    )
});

// The columns a row other than a tag holds none of.
const NO_TAG_SQL: &str = "NULL AS tag_fold, NULL AS session_last_activity_at";

// The body columns a row other than a log row holds none of.
const NO_BODY_SQL: &str = "NULL, NULL, NULL, NULL";

// Where the body columns start, after the key, owner, text, log position and tag columns.
const BODY_COLUMN: usize = 7;

// How a read chooses its rows: the rows at some keys, or the next rows in order within a range of
// rowids.
#[derive(Clone, Copy)]
enum RowChoice {
    Keys,
    Between,
}

// The condition and order that choose a read's rows by the source table's rowid, `rowid_sql`.
fn chosen_rows_sql(choice: RowChoice, rowid_sql: &str) -> String {
    match choice {
        RowChoice::Keys => format!("AND {rowid_sql} IN (SELECT value FROM json_each(@rowids))"),
        RowChoice::Between => format!(
            "AND {rowid_sql} > @after_rowid AND {rowid_sql} <= @through_rowid
       ORDER BY {rowid_sql} LIMIT {INDEX_BATCH_ROW_LIMIT}"
        ),
    }
}

// Each kind's source table's highest rowid.
fn last_rowid_sql(kind: IndexRowKind) -> &'static str {
    match kind {
        IndexRowKind::Event => "SELECT max(rowid) FROM session_events",
        IndexRowKind::Title => "SELECT max(rowid) FROM sessions",
        IndexRowKind::Group => "SELECT max(rowid) FROM session_groups",
        IndexRowKind::Tag => "SELECT max(rowid) FROM session_tags",
    }
}

// Each kind's rows: the key, the owner's key, the text and, for a log row, its id and position,
// and for a tag, its fold and its session's last activity.
fn row_sql(kind: IndexRowKind, choice: RowChoice) -> String {
    match kind {
        IndexRowKind::Event => format!(
            "SELECT {key} AS key, session.rowid AS owner_key,
           {event_text} AS text, event.id AS event_id, event.sequence, {NO_TAG_SQL},
           {event_body}
      FROM session_events AS event
      JOIN sessions AS session ON session.id = event.session_id
     WHERE event.type IN ({types}) AND ({event_text}) IS NOT NULL
       AND {outside_skipped}
       {chosen}",
            key = index_key_sql("event.rowid", IndexRowKind::Event),
            event_text = EVENT_TEXT_SQL.as_str(),
            event_body = EVENT_BODY_SQL.as_str(),
            types = INDEXED_EVENT_TYPES_SQL.as_str(),
            outside_skipped = outside_skipped_ranges_sql("event"),
            chosen = chosen_rows_sql(choice, "event.rowid"),
        ),
        IndexRowKind::Title => format!(
            "SELECT {key} AS key, rowid AS owner_key, name AS text,
           NULL AS event_id, NULL AS sequence, {NO_TAG_SQL}, {NO_BODY_SQL}
      FROM sessions
     WHERE name IS NOT NULL {chosen}",
            key = index_key_sql("rowid", IndexRowKind::Title),
            chosen = chosen_rows_sql(choice, "rowid"),
        ),
        IndexRowKind::Group => format!(
            "SELECT {key} AS key, rowid AS owner_key, name AS text,
           NULL AS event_id, NULL AS sequence, {NO_TAG_SQL}, {NO_BODY_SQL}
      FROM session_groups
     WHERE TRUE {chosen}",
            key = index_key_sql("rowid", IndexRowKind::Group),
            chosen = chosen_rows_sql(choice, "rowid"),
        ),
        IndexRowKind::Tag => format!(
            "SELECT {key} AS key, session.rowid AS owner_key, tag.tag AS text,
           NULL AS event_id, NULL AS sequence, tag.tag_folded AS tag_fold,
           session.last_activity_at AS session_last_activity_at, {NO_BODY_SQL}
      FROM session_tags AS tag
      JOIN sessions AS session ON session.id = tag.session_id
     WHERE TRUE {chosen}",
            key = index_key_sql("tag.rowid", IndexRowKind::Tag),
            chosen = chosen_rows_sql(choice, "tag.rowid"),
        ),
    }
}

/// Reads index rows from their source tables on one connection. A stored value that does not
/// read as its type fails the read with rusqlite's error, keeping why.
pub(crate) struct IndexRowReader<'connection> {
    /// The connection the rows are read on.
    reader: &'connection Connection,
}

impl<'connection> IndexRowReader<'connection> {
    /// A reader over `reader`.
    pub(crate) fn new(reader: &'connection Connection) -> Self {
        Self { reader }
    }

    /// The highest rowid of the `kind` rows' source table, 0 when it holds none.
    pub(crate) fn last_rowid(&self, kind: IndexRowKind) -> rusqlite::Result<i64> {
        let highest: Option<i64> = self
            .reader
            .prepare_cached(last_rowid_sql(kind))?
            .query_row([], |row| row.get(0))?;
        Ok(highest.unwrap_or(0))
    }

    /// The rows at these keys as the database holds them now, by key. A key whose row is gone, or
    /// no longer holds text, has none.
    pub(crate) fn read_rows(
        &self,
        keys: impl IntoIterator<Item = u64>,
    ) -> rusqlite::Result<HashMap<u64, SourceRow>> {
        let mut rowids_by_kind: Vec<(IndexRowKind, Vec<u64>)> = Vec::new();
        for key in keys {
            let kind = index_row_kind_of(key);
            let rowid = source_rowid_of(key);
            match rowids_by_kind
                .iter_mut()
                .find(|(listed, _)| *listed == kind)
            {
                Some((_, rowids)) => rowids.push(rowid),
                None => rowids_by_kind.push((kind, vec![rowid])),
            }
        }
        let mut rows = HashMap::new();
        for (kind, rowids) in rowids_by_kind {
            let rowids = serde_json::to_string(&rowids)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
            let mut statement = self
                .reader
                .prepare_cached(&row_sql(kind, RowChoice::Keys))?;
            let read = statement.query_map(named_params! { "@rowids": rowids }, |row| {
                source_row_of(kind, row)
            })?;
            for row in read {
                let row = row?;
                rows.insert(row.key, row);
            }
        }
        Ok(rows)
    }

    /// The `kind` rows past the source rowid `after_rowid` through `through_rowid`, in rowid
    /// order, each taken out of `room`, up to the first that `fits` refuses: none once the room
    /// holds no row or no text, and the row whose text passes the room's is the last. None once
    /// every row in the range has been read.
    pub(crate) fn read_rows_between(
        &self,
        kind: IndexRowKind,
        after_rowid: i64,
        through_rowid: i64,
        room: &mut IndexBatchRoom,
        mut fits: impl FnMut(&SourceRow) -> bool,
    ) -> rusqlite::Result<Vec<SourceRow>> {
        let mut rows = Vec::new();
        if room.is_full() {
            return Ok(rows);
        }
        let mut statement = self
            .reader
            .prepare_cached(&row_sql(kind, RowChoice::Between))?;
        let read = statement.query_map(
            named_params! { "@after_rowid": after_rowid, "@through_rowid": through_rowid },
            |row| source_row_of(kind, row),
        )?;
        for row in read {
            let row = row?;
            if !fits(&row) {
                break;
            }
            room.rows = room.rows.saturating_sub(1);
            room.text_bytes = room.text_bytes.saturating_sub(row.text.len());
            rows.push(row);
            if room.is_full() {
                break;
            }
        }
        Ok(rows)
    }
}

/// The row as the index takes it.
pub(crate) fn index_row_of(row: SourceRow) -> IndexRow {
    IndexRow {
        key: row.key,
        kind: row.kind,
        owner_key: row.owner_key,
        text: row.text,
        tag: row.tag,
    }
}

fn source_row_of(kind: IndexRowKind, row: &Row<'_>) -> rusqlite::Result<SourceRow> {
    let event_id: Option<String> = row.get(3)?;
    let sequence: Option<i64> = row.get(4)?;
    let tag_fold: Option<String> = row.get(5)?;
    let session_last_activity_ms = optional_text_column(row, 6, |text| last_activity_ms(&text))?;
    let mut text: String = row.get(2)?;
    if let Some(body) = StoredBodyColumns::read(row, BODY_COLUMN + 1)?.decode(BODY_COLUMN + 1)? {
        text.push_str(row.get_ref(BODY_COLUMN)?.as_str()?);
        text.push_str(&body);
    }
    Ok(SourceRow {
        key: rowid_column(row, 0)?,
        kind,
        owner_key: rowid_column(row, 1)?,
        text,
        log_row: event_id
            .zip(sequence)
            .map(|(event_id, sequence)| LogRowPosition { event_id, sequence }),
        tag: tag_fold
            .zip(session_last_activity_ms)
            .map(|(fold, session_last_activity_ms)| IndexRowTag {
                fold,
                session_last_activity_ms,
            }),
    })
}

// A stored instant as milliseconds since the Unix epoch, as the index orders a tag's sessions;
// fails on text that is not an instant.
fn last_activity_ms(text: &str) -> Result<u64, jiff::Error> {
    let instant: jiff::Timestamp = text.parse()?;
    // The index only orders by it, so an instant before 1970 holds 0 and sorts first.
    Ok(u64::try_from(instant.as_millisecond()).unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use sidekicks_search::index::IndexRowKind;

    use super::{IndexRowReader, empty_index_batch_room};
    use crate::session::directory::test_rows::insert_session_row;
    use crate::transcript::test_log::TranscriptTestLog;

    // A reply and a tool call's arguments past 1 KiB are stored compressed, and the index takes
    // their decoded text whole, a word at their end among it. Killed by indexing the stored bytes
    // or a body cut short.
    #[test]
    fn the_index_takes_a_compressed_body_as_its_whole_text() {
        let log = TranscriptTestLog::new();
        insert_session_row(&log.writer, log.session_id.text().as_str(), None, None);
        let reply = format!("{} quokka", "words ".repeat(400));
        log.reply("m1", None, &reply);
        let arguments = format!(
            "{{\"path\": \"{}\", \"note\": \"wombat\"}}",
            "a/".repeat(700)
        );
        log.write(
            json!({
                "type": "agent.toolCall.invoked",
                "payload": {
                    "sessionId": log.session_id,
                    "runId": log.run_id,
                    "toolName": "edit",
                },
            }),
            Some(&arguments),
        );

        let reader = log.reader();
        let mut room = empty_index_batch_room();
        let texts: Vec<String> = IndexRowReader::new(&reader)
            .read_rows_between(IndexRowKind::Event, 0, i64::MAX, &mut room, |_| true)
            .expect("the rows read")
            .into_iter()
            .map(|row| row.text)
            .collect();
        assert_eq!(texts, [reply, format!("edit {arguments}")]);
    }
}
