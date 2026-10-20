//! Reads the search index's outbox into the batches the index applies, and deletes what the index
//! has applied. A read takes the outbox rows waiting past the last one read, in id order, and reads
//! in the same read transaction each row they name with its text as the database holds it then, a
//! row gone by then as a removal, and each group whose members changed with its members then. A
//! session or group deleted with its rows ends its batch, so rows a later session or group writes
//! at a key it held always land in a later commit than the removal.

use std::borrow::Cow;
use std::collections::{BTreeSet, HashSet};
use std::sync::LazyLock;

use rusqlite::Connection;
use rusqlite::types::Value;
use sidekicks_search::index::{GroupMembers, IndexBatch, IndexRowKind, RemovedOwner};

use crate::database::statement::{StatementBindings, WriteStatement};
use crate::database::stored_column::{rowid_column, text_column};
use crate::database::writer::{DatabaseWriter, WriteError};
use crate::session::search::index::rows::{
    INDEX_BATCH_ROW_LIMIT, IndexRowReader, empty_index_batch_room, index_row_of,
};
use crate::session::search::rowid_floors::{RowidFloorLog, floors_let_go_statement};

/// What an outbox row asks of the index: read the row at its key again, take every row its owner
/// held out, or read its group's members again. Stored by its camelCase name.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, strum::VariantArray, strum::IntoStaticStr, strum::EnumString,
)]
#[strum(serialize_all = "camelCase")]
pub(crate) enum OutboxOperation {
    /// Read the row at the entry's key again; a row gone by then is removed.
    Row,
    /// Take every row the entry's owner held out of the index.
    Owner,
    /// Read the members of the entry's group again.
    Members,
}

/// The statements an outbox reader prepares: its own five, the index row reads by key of each of
/// the four row kinds, and the rowid floor log's position.
pub const OUTBOX_STATEMENT_CAPACITY: usize = 5 + 4 + 1;

/// What one read of the outbox found.
#[derive(Clone, Debug)]
pub(crate) struct OutboxRead {
    /// The batch to apply; `None` when no outbox row waits.
    pub(crate) batch: Option<IndexBatch>,
    /// Where the rowid floor log stood at the read when the read left no outbox row waiting, so the
    /// index matches the database at that point once the batch is applied; `None` while rows wait
    /// past the batch.
    pub(crate) floor_position: Option<i64>,
}

/// The outbox rows a durable commit lets the daemon delete, and the floor log entries with them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct AppliedOutbox {
    /// The highest outbox id the index has durably applied.
    pub(crate) last_outbox_id: u64,
    /// The highest floor log entry no held search and no newer view reads any more.
    pub(crate) kept_floor_position: i64,
}

// One outbox row as the read takes it.
struct OutboxEntry {
    id: u64,
    index_key: u64,
    kind: IndexRowKind,
    owner_key: u64,
    operation: OutboxOperation,
}

static ENTRIES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT id, index_key, kind, owner_key, operation FROM session_search_outbox
   WHERE id > ? ORDER BY id LIMIT {INDEX_BATCH_ROW_LIMIT}"
    )
});

const IS_ENTRY_AFTER_SQL: &str = "SELECT EXISTS (SELECT 1 FROM session_search_outbox WHERE id > ?)";

// The outbox's ids only grow, so the highest it has given is SQLite's record of its last one.
const HIGHEST_ID_GIVEN_SQL: &str = "
  SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'session_search_outbox'), 0)";

// A group's members in session id order, the order the index breaks ties among them in.
const GROUP_MEMBERS_SQL: &str = "
  SELECT session.rowid FROM session_groups AS session_group
    JOIN sessions AS session ON session.group_id = session_group.id
   WHERE session_group.rowid = ? ORDER BY session.id";

const EVERY_GROUP_MEMBER_SQL: &str = "
  SELECT session_group.rowid AS group_key, session.rowid AS session_key
    FROM session_groups AS session_group
    JOIN sessions AS session ON session.group_id = session_group.id
   ORDER BY session_group.rowid, session.id";

// Applied outbox rows are deleted at most this many to a write, so the deletes after a rebuild of
// a large database never hold the database writer for long.
const APPLIED_ROWS_PER_DELETE: usize = 10_000;

static APPLIED_ROWS_DELETE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "DELETE FROM session_search_outbox WHERE id IN (
    SELECT id FROM session_search_outbox WHERE id <= ? ORDER BY id
     LIMIT {APPLIED_ROWS_PER_DELETE})"
    )
});

// The rows a batch names are read this many outbox rows at a time, so a batch stops within one
// such read past its text bound: a log row's stored body is bounded in code points.
const ROWS_READ_AT_ONCE: usize = 32;

/// Reads the outbox on one connection, with the index rows and the rowid floor log it names read
/// on the same one. A stored value that does not read as its type fails the read with rusqlite's
/// error, keeping why.
pub(crate) struct OutboxReader<'connection> {
    /// The connection the outbox is read on.
    reader: &'connection Connection,
    /// The index rows the outbox names.
    rows: IndexRowReader<'connection>,
    /// Where the rowid floor log stands.
    floor_log: RowidFloorLog<'connection>,
}

impl<'connection> OutboxReader<'connection> {
    /// A reader over `reader`.
    pub(crate) fn new(reader: &'connection Connection) -> Self {
        Self {
            reader,
            rows: IndexRowReader::new(reader),
            floor_log: RowidFloorLog::new(reader),
        }
    }

    /// The highest id the outbox has given, 0 before its first row. An index whose newest commit
    /// records a higher one was built from another database.
    pub(crate) fn highest_id_given(&self) -> rusqlite::Result<u64> {
        self.reader
            .prepare_cached(HIGHEST_ID_GIVEN_SQL)?
            .query_row([], |row| rowid_column(row, 0))
    }

    /// The next batch past the outbox id `after_id`, read in one read transaction, so the
    /// connection must hold none open: at most [`INDEX_BATCH_ROW_LIMIT`] outbox rows, no more once
    /// their rows' text fills a batch's text bound, and none past a deleted session or group.
    pub(crate) fn read(&self, after_id: u64) -> rusqlite::Result<OutboxRead> {
        let snapshot = self.reader.unchecked_transaction()?;
        let read = self.read_in_snapshot(after_id)?;
        snapshot.commit()?;
        Ok(read)
    }

    /// Every group's members as the database holds them now.
    pub(crate) fn read_every_group_members(&self) -> rusqlite::Result<Vec<GroupMembers>> {
        let mut statement = self.reader.prepare_cached(EVERY_GROUP_MEMBER_SQL)?;
        let members =
            statement.query_map([], |row| Ok((rowid_column(row, 0)?, rowid_column(row, 1)?)))?;
        let mut groups: Vec<GroupMembers> = Vec::new();
        for member in members {
            let (group_key, session_key) = member?;
            match groups.last_mut() {
                Some(group) if group.group_key == group_key => group.session_keys.push(session_key),
                Some(_) | None => groups.push(GroupMembers {
                    group_key,
                    session_keys: vec![session_key],
                }),
            }
        }
        Ok(groups)
    }

    fn read_in_snapshot(&self, after_id: u64) -> rusqlite::Result<OutboxRead> {
        let entries = self.entries_after(after_id)?;
        if entries.is_empty() {
            return Ok(OutboxRead {
                batch: None,
                floor_position: Some(self.floor_log.position()?),
            });
        }
        let mut rows = Vec::new();
        let mut removed_keys = Vec::new();
        let mut removed_owners = Vec::new();
        let mut member_group_keys = BTreeSet::new();
        let mut read_keys = HashSet::new();
        let mut last_outbox_id = after_id;
        let mut room = empty_index_batch_room();
        let mut is_batch_ended = false;
        for chunk in entries.chunks(ROWS_READ_AT_ONCE) {
            if is_batch_ended {
                break;
            }
            let mut keys = Vec::new();
            for entry in chunk {
                last_outbox_id = entry.id;
                match entry.operation {
                    OutboxOperation::Row => {
                        if read_keys.insert(entry.index_key) {
                            keys.push(entry.index_key);
                        }
                    }
                    OutboxOperation::Members => {
                        member_group_keys.insert(entry.owner_key);
                    }
                    OutboxOperation::Owner => {
                        removed_owners.push(RemovedOwner {
                            owner_key: entry.owner_key,
                            is_group: entry.kind == IndexRowKind::Group,
                        });
                        is_batch_ended = true;
                        break;
                    }
                }
            }
            let mut current_rows = self.rows.read_rows(keys.iter().copied())?;
            for key in keys {
                match current_rows.remove(&key) {
                    Some(row) => {
                        room.text_bytes = room.text_bytes.saturating_sub(row.text.len());
                        rows.push(index_row_of(row));
                    }
                    None => removed_keys.push(key),
                }
            }
            is_batch_ended |= room.text_bytes == 0;
        }
        let group_members = member_group_keys
            .into_iter()
            .map(|group_key| {
                Ok(GroupMembers {
                    group_key,
                    session_keys: self.group_members(group_key)?,
                })
            })
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let floor_position = if self.is_entry_after(last_outbox_id)? {
            None
        } else {
            Some(self.floor_log.position()?)
        };
        Ok(OutboxRead {
            batch: Some(IndexBatch {
                last_outbox_id,
                rows,
                removed_keys,
                removed_owners,
                group_members,
            }),
            floor_position,
        })
    }

    fn entries_after(&self, after_id: u64) -> rusqlite::Result<Vec<OutboxEntry>> {
        let mut statement = self.reader.prepare_cached(ENTRIES_SQL.as_str())?;
        let entries = statement.query_map([sqlite_rowid(after_id)], |row| {
            Ok(OutboxEntry {
                id: rowid_column(row, 0)?,
                index_key: rowid_column(row, 1)?,
                kind: text_column(row, 2, |word| word.parse::<IndexRowKind>())?,
                owner_key: rowid_column(row, 3)?,
                operation: text_column(row, 4, |word| word.parse::<OutboxOperation>())?,
            })
        })?;
        entries.collect()
    }

    fn is_entry_after(&self, outbox_id: u64) -> rusqlite::Result<bool> {
        self.reader
            .prepare_cached(IS_ENTRY_AFTER_SQL)?
            .query_row([sqlite_rowid(outbox_id)], |row| row.get(0))
    }

    fn group_members(&self, group_key: u64) -> rusqlite::Result<Vec<u64>> {
        let mut statement = self.reader.prepare_cached(GROUP_MEMBERS_SQL)?;
        let session_keys =
            statement.query_map([sqlite_rowid(group_key)], |row| rowid_column(row, 0))?;
        session_keys.collect()
    }
}

/// Deletes the outbox rows up to `applied.last_outbox_id` through `writer`, a bounded number to a
/// write, and with the first write the floor log's entries up to `applied.kept_floor_position`.
/// Fails with the failed write's error; the rows it left are deleted with the next applied batch's.
pub(crate) async fn delete_applied_outbox(
    writer: &DatabaseWriter,
    applied: AppliedOutbox,
) -> Result<(), WriteError> {
    let delete_applied = WriteStatement {
        sql: Cow::Borrowed(APPLIED_ROWS_DELETE_SQL.as_str()),
        bindings: StatementBindings::Positional(vec![Value::Integer(sqlite_rowid(
            applied.last_outbox_id,
        ))]),
        expected_row_count: None,
    };
    let mut results = writer
        .write(vec![
            delete_applied.clone(),
            floors_let_go_statement(applied.kept_floor_position),
        ])
        .await?;
    while results
        .first()
        .is_some_and(|deleted| deleted.row_count == APPLIED_ROWS_PER_DELETE)
    {
        results = writer.write(vec![delete_applied.clone()]).await?;
    }
    Ok(())
}

// An outbox id or a group key, each a SQLite rowid, as SQLite binds it.
fn sqlite_rowid(rowid: u64) -> i64 {
    i64::try_from(rowid).expect("a SQLite rowid is below 2^63")
}
