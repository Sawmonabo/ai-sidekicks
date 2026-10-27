//! The text the search index holds for each source row, read from the database as it is now: a
//! settled message's text, a tool call's name and arguments, a session's title, a group's name and
//! a tag, with a tag's fold and its session's last activity beside it. A row's stored body is read
//! only when its text is wanted, a frame at a time into pages, so no more than a page of it is held
//! at once. The outbox applier, the rebuild and the hit reader all read rows here, so a hit's line
//! is marked on the same pages the index saw. A log row belongs to its session through the
//! session's directory row; a log row of a session with none, which only the daemon's own sentinel
//! session lacks, is no index row, and neither is a row in a range its session skipped past as
//! damaged. A row a value of which does not read as its type, such as text that is not UTF-8, its
//! payload's text, body encoding or length or its stored body, is no index row either: a read
//! hands it back damaged on rusqlite's conversion or UTF-8 error, so every reader passes it over
//! alike, and only SQLite's refusal of a read fails it.

use std::collections::HashMap;
use std::mem;
use std::ops::ControlFlow;
use std::sync::LazyLock;

use rusqlite::types::Value;
use rusqlite::{Connection, Row, named_params};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_search::index::{IndexRowKind, IndexRowTag, find_page_end};

use crate::search::index::columns::{index_key_sql, index_row_kind_of, source_rowid_of};
use sidekicks_store::database::sql_list::sql_list_of;
use sidekicks_store::database::stored_column::{
    optional_text_column, rowid_column, wrong_type_failure,
};
use sidekicks_store::events::content::codec::{
    StoredBodyPlace, stored_body_encoding_sql, stored_body_length_sql,
};
use sidekicks_store::events::session::skipped_ranges::outside_skipped_ranges_sql;

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
    /// The row's text as the database holds it now before its stored body, the body's separator
    /// included: all of its text when it has no body.
    pub(crate) text: String,
    /// Where a log row's stored body sits, read only through [`IndexRowReader::for_each_page`];
    /// `None` on a row without one.
    pub(crate) body: Option<StoredBodyPlace>,
    /// A log row's id and position in its session's log; `None` on a title, group or tag.
    pub(crate) log_row: Option<LogRowPosition>,
    /// A tag row's fold and its session's last activity; `None` on every other row.
    pub(crate) tag: Option<IndexRowTag>,
}

impl SourceRow {
    /// The row's text length in UTF-8 bytes, its body's as its payload states it.
    pub(crate) fn text_len(&self) -> usize {
        let body_len = self
            .body
            .as_ref()
            .and_then(|body| body.content_length)
            .map_or(0, |length| usize::try_from(length).unwrap_or(usize::MAX));
        self.text.len().saturating_add(body_len)
    }
}

/// A log row's event id and its sequence in its session's log.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LogRowPosition {
    /// The event's id.
    pub(crate) event_id: String,
    /// The event's sequence in its session's log.
    pub(crate) sequence: i64,
}

/// A source row as a read finds it: whole, or damaged in a value of its own.
#[derive(Debug)]
pub(crate) enum SourceRowRead {
    /// Every value of the row read as its type.
    Whole(SourceRow),
    /// A value of the row did not read as its type.
    Damaged(DamagedSourceRow),
}

impl SourceRowRead {
    /// The row's index key.
    pub(crate) fn key(&self) -> u64 {
        match self {
            Self::Whole(row) => row.key,
            Self::Damaged(damaged) => damaged.key,
        }
    }

    /// The text the row charges to a batch's bound, in UTF-8 bytes: none for a damaged row.
    pub(crate) fn text_len(&self) -> usize {
        match self {
            Self::Whole(row) => row.text_len(),
            Self::Damaged(_) => 0,
        }
    }
}

/// A source row a value of which does not read as its type: its payload's text, body encoding or
/// length, its stored body or another column. It is no index row. Only rusqlite's conversion or
/// UTF-8 error makes one; SQLite's own refusal of a read stays a failed read.
#[derive(Debug)]
pub(crate) struct DamagedSourceRow {
    /// The row's index key.
    pub(crate) key: u64,
    /// The session the row belongs to; for a group's name, the group.
    pub(crate) owner_key: u64,
    /// A log row's sequence in its session's log; `None` on a title, group or tag.
    pub(crate) sequence: Option<i64>,
    /// The conversion or UTF-8 error the value failed with, keeping why.
    pub(crate) damage: rusqlite::Error,
}

/// Why [`IndexRowReader::for_each_page`] did not hand over every page of a row.
#[derive(Debug)]
pub(crate) enum PageReadError {
    /// The row's stored body is damaged.
    Damaged(DamagedSourceRow),
    /// SQLite refused the body's read.
    Refused(rusqlite::Error),
}

// `error` as the damage of the row it was read from when it is rusqlite's conversion or UTF-8
// error, which a value that does not read as its type fails with; any other error fails the read,
// handed back.
fn damage_of(
    error: rusqlite::Error,
    key: u64,
    owner_key: u64,
    sequence: Option<i64>,
) -> Result<DamagedSourceRow, rusqlite::Error> {
    if !matches!(
        error,
        rusqlite::Error::FromSqlConversionFailure(..) | rusqlite::Error::Utf8Error(..)
    ) {
        return Err(error);
    }
    Ok(DamagedSourceRow {
        key,
        owner_key,
        sequence,
        damage: error,
    })
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

// A log row's body, which a page read decodes a frame at a time after its text: an agent's reply,
// or a tool's arguments after a space; the separator, then where the body is stored, as
// `StoredBodyPlace` reads it: the row's rowid when it holds a body, its encoding and its length.
static EVENT_BODY_SQL: LazyLock<String> = LazyLock::new(|| {
    let agent_message = SessionEventType::AgentMessageSent.as_str();
    let tool_call = SessionEventType::AgentToolCallInvoked.as_str();
    format!(
        "CASE WHEN event.type = '{tool_call}' THEN ' ' ELSE '' END,
           CASE WHEN json_valid(event.payload)
                 AND event.type IN ('{agent_message}', '{tool_call}')
                 AND event.content_payload IS NOT NULL
                THEN event.rowid END,
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

/// Reads index rows from their source tables on one connection. A row a value of which does not
/// read as its type, on rusqlite's conversion or UTF-8 error, is handed back damaged; SQLite's
/// refusal fails the read with its error.
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

    /// The rows at these keys as the database holds them now, each whole or damaged, by key. A key
    /// whose row is gone, or no longer holds text, has none.
    pub(crate) fn read_rows(
        &self,
        keys: impl IntoIterator<Item = u64>,
    ) -> rusqlite::Result<HashMap<u64, SourceRowRead>> {
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
                rows.insert(row.key(), row);
            }
        }
        Ok(rows)
    }

    /// The `kind` rows past the source rowid `after_rowid` through `through_rowid`, in rowid
    /// order, each whole or damaged and taken out of `room`, up to the first that `fits` refuses:
    /// none once the room holds no row or no text, and the row whose text passes the room's is the
    /// last. None once every row in the range has been read.
    pub(crate) fn read_rows_between(
        &self,
        kind: IndexRowKind,
        after_rowid: i64,
        through_rowid: i64,
        room: &mut IndexBatchRoom,
        mut fits: impl FnMut(&SourceRowRead) -> bool,
    ) -> rusqlite::Result<Vec<SourceRowRead>> {
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
            room.text_bytes = room.text_bytes.saturating_sub(row.text_len());
            rows.push(row);
            if room.is_full() {
                break;
            }
        }
        Ok(rows)
    }

    /// Hands `row`'s text to `each` a page at a time, in order, so no more than a page of its body
    /// is held at once: its text before the body with the body's first frame, then each later
    /// frame, each page ending before the word it would cut and the next beginning with that word.
    /// Stops once `each` breaks, answering what it broke with; `None` once every page was handed.
    /// Fails with [`PageReadError::Damaged`] when the body is damaged, after handing the pages
    /// before the damage, and with [`PageReadError::Refused`] when SQLite refuses the body's read.
    pub(crate) fn for_each_page<Stop>(
        &self,
        row: &SourceRow,
        mut each: impl FnMut(String) -> ControlFlow<Stop>,
    ) -> Result<Option<Stop>, PageReadError> {
        let mut page = row.text.clone();
        let Some(body) = &row.body else {
            return Ok(each(page).break_value());
        };
        let mut is_frame_held = false;
        let streamed = body
            .stream_column(self.reader, BODY_COLUMN + 1, |frame| {
                // A frame after the first starts a page: the held one ends before the word it would
                // cut, and that word begins the next, so a word on a frame's edge stays one token.
                if is_frame_held {
                    let cut_word = page.split_off(find_page_end(&page));
                    if let ControlFlow::Break(stop) = each(mem::replace(&mut page, cut_word)) {
                        return ControlFlow::Break(stop);
                    }
                }
                page.push_str(frame);
                is_frame_held = true;
                ControlFlow::Continue(())
            })
            .map_err(|error| {
                let sequence = row.log_row.as_ref().map(|log_row| log_row.sequence);
                match damage_of(error, row.key, row.owner_key, sequence) {
                    Ok(damaged) => PageReadError::Damaged(damaged),
                    Err(refused) => PageReadError::Refused(refused),
                }
            })?;
        match streamed {
            ControlFlow::Break(stop) => Ok(Some(stop)),
            ControlFlow::Continue(()) => Ok(each(page).break_value()),
        }
    }
}

// A row read from its columns: its body's place, not its body, which is read only when wanted.
// Its key, owner and sequence are read first, so a later value that does not read as its type
// hands the row back damaged.
fn source_row_of(kind: IndexRowKind, row: &Row<'_>) -> rusqlite::Result<SourceRowRead> {
    let key = rowid_column(row, 0)?;
    let owner_key = rowid_column(row, 1)?;
    let sequence: Option<i64> = row.get(4)?;
    match whole_source_row_of(kind, row, key, owner_key, sequence) {
        Ok(whole) => Ok(SourceRowRead::Whole(whole)),
        Err(error) => damage_of(error, key, owner_key, sequence).map(SourceRowRead::Damaged),
    }
}

// The rest of a row's values, after its key, owner and sequence.
fn whole_source_row_of(
    kind: IndexRowKind,
    row: &Row<'_>,
    key: u64,
    owner_key: u64,
    sequence: Option<i64>,
) -> rusqlite::Result<SourceRow> {
    let event_id: Option<String> = row.get(3)?;
    let tag_fold: Option<String> = row.get(5)?;
    let session_last_activity_ms = optional_text_column(row, 6, |text| last_activity_ms(&text))?;
    let mut text = row_text_column(row, 2)?;
    let body = StoredBodyPlace::read(row, BODY_COLUMN + 1)?;
    if body.is_some() {
        text.push_str(row.get_ref(BODY_COLUMN)?.as_str()?);
    }
    Ok(SourceRow {
        key,
        kind,
        owner_key,
        text,
        body,
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

// A row's text, read from `index`: a payload's member is any JSON value, so one that is not text
// fails with rusqlite's conversion error, as the damage it is.
fn row_text_column(row: &Row<'_>, index: usize) -> rusqlite::Result<String> {
    match row.get::<_, Value>(index)? {
        Value::Text(text) => Ok(text),
        other @ (Value::Null | Value::Integer(_) | Value::Real(_) | Value::Blob(_)) => {
            Err(wrong_type_failure(index, &other))
        }
    }
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
    use std::ops::ControlFlow;

    use rstest::rstest;
    use rusqlite::types::{FromSqlError, Type};
    use serde_json::json;
    use sidekicks_contracts::jsonrpc::page::PAGE_MAX_BYTES;
    use sidekicks_search::index::IndexRowKind;

    use super::{IndexRowReader, SourceRow, SourceRowRead, damage_of, empty_index_batch_room};
    use crate::transcript::test_log::TranscriptTestLog;
    use sidekicks_store::database::schema::session_directory::insert_session_row;
    use sidekicks_store::events::content::codec::out_of_memory_read_failure;

    // Every page of the whole row `read`'s text, in order.
    fn pages_of(rows: &IndexRowReader<'_>, read: &SourceRowRead) -> Vec<String> {
        let row = whole(read);
        let mut pages = Vec::new();
        let stopped = rows
            .for_each_page(row, |page| {
                pages.push(page);
                ControlFlow::<()>::Continue(())
            })
            .expect("the pages read");
        assert!(stopped.is_none(), "every page is handed");
        pages
    }

    fn whole(read: &SourceRowRead) -> &SourceRow {
        let SourceRowRead::Whole(row) = read else {
            panic!("the row reads whole, not {read:?}");
        };
        row
    }

    // rusqlite's conversion and UTF-8 errors damage a row; SQLite out of memory and a column of a
    // type the read does not take are refusals, handed back to fail the read. Killed by the refusal
    // guard deleted, which passes a refused row over and drops it from the index for good, and by
    // a UTF-8 error left out of the damage, which stalls indexing on one flipped bit.
    #[rstest]
    #[case::out_of_memory(out_of_memory_read_failure(), false)]
    #[case::column_type(
        rusqlite::Error::InvalidColumnType(2, "text".to_owned(), Type::Integer),
        false
    )]
    #[case::conversion(
        rusqlite::Error::FromSqlConversionFailure(
            2,
            Type::Text,
            Box::new(FromSqlError::InvalidType)
        ),
        true
    )]
    #[case::utf8(
        rusqlite::Error::Utf8Error(
            2,
            String::from_utf8(vec![0xFA])
                .expect_err("0xFA begins no UTF-8 character")
                .utf8_error()
        ),
        true
    )]
    fn only_a_conversion_or_utf8_error_damages_a_row(
        #[case] error: rusqlite::Error,
        #[case] is_damage: bool,
    ) {
        assert_eq!(damage_of(error, 1, 2, Some(3)).is_ok(), is_damage);
    }

    // A reply and a tool call's arguments past 1 KiB are stored compressed, and the index takes
    // their decoded text whole, a word at their end among it. Killed by indexing the stored bytes
    // or a body cut short.
    #[test]
    fn the_index_takes_a_compressed_body_as_its_whole_text() {
        let log = TranscriptTestLog::new(crate::questions::schema::schema_parts());
        insert_session_row(
            &log.session_log.writer,
            log.session_log.session_id.text().as_str(),
            None,
            None,
        );
        let reply = format!("{} quokka", "words ".repeat(400));
        log.session_log.reply("m1", None, &reply);
        let arguments = format!(
            "{{\"path\": \"{}\", \"note\": \"wombat\"}}",
            "a/".repeat(700)
        );
        log.session_log.write(
            json!({
                "type": "agent.toolCall.invoked",
                "payload": {
                    "sessionId": log.session_log.session_id,
                    "runId": log.session_log.run_id,
                    "toolName": "edit",
                },
            }),
            Some(&arguments),
        );

        let reader = log.session_log.reader();
        let rows = IndexRowReader::new(&reader);
        let mut room = empty_index_batch_room();
        let texts: Vec<String> = rows
            .read_rows_between(IndexRowKind::Event, 0, i64::MAX, &mut room, |_| true)
            .expect("the rows read")
            .iter()
            .map(|row| pages_of(&rows, row).concat())
            .collect();
        assert_eq!(texts, [reply, format!("edit {arguments}")]);
    }

    // A reply of three frames is read as three pages holding every byte, its last word on the last
    // page only, and no page ends inside a word: the 6-byte words do not divide a frame. A reader
    // that stops at the first page is handed that page alone and answers its stop. Killed by
    // reading the body whole as one page, by a cut before the first frame (an empty first page),
    // by ending a page at its frame's edge, which cuts a word in two, and by a stop the stream
    // reads past.
    #[test]
    fn a_long_body_is_read_as_pages_that_end_between_words() {
        let log = TranscriptTestLog::new(crate::questions::schema::schema_parts());
        insert_session_row(
            &log.session_log.writer,
            log.session_log.session_id.text().as_str(),
            None,
            None,
        );
        let reply = format!(
            "{}quokka",
            "words ".repeat((2 * PAGE_MAX_BYTES + 4_000) / 6)
        );
        log.session_log.reply("m1", None, &reply);

        let reader = log.session_log.reader();
        let rows = IndexRowReader::new(&reader);
        let mut room = empty_index_batch_room();
        let read = rows
            .read_rows_between(IndexRowKind::Event, 0, i64::MAX, &mut room, |_| true)
            .expect("the rows read");
        let [row] = read.as_slice() else {
            panic!("one row reads, not {}", read.len());
        };
        let pages = pages_of(&rows, row);
        assert_eq!(pages.len(), 3);
        assert_eq!(pages.concat(), reply);
        let pages_with_word: Vec<bool> = pages.iter().map(|page| page.contains("quokka")).collect();
        assert_eq!(pages_with_word, [false, false, true]);
        for page in &pages[..2] {
            assert!(page.ends_with(' '), "a page ends inside a word");
        }
        let mut calls = 0;
        let stopped = rows
            .for_each_page(whole(row), |_page| {
                calls += 1;
                ControlFlow::Break(calls)
            })
            .expect("the first page reads");
        assert_eq!(stopped, Some(1));
        assert_eq!(calls, 1);
    }
}
