//! Which index rows a held search's view still names. A source table gives a new row the rowid
//! after its highest, so once a delete lowers a table's highest rowid, a later row can take a rowid
//! a held view indexed, and reading that key from the database would read another row. Every such
//! delete logs the table's new highest rowid. A row the view indexed is still that row while its
//! source rowid is no higher than every highest rowid logged since the view's database state; one
//! higher was deleted since, whatever sits at its rowid now. This holds while the source tables
//! insert without naming a rowid and never `REPLACE`, whose deletes fire no trigger. The live
//! index lets go of the entries no search being read, no held search and no newer view needs,
//! through the database writer.

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::Connection;
use rusqlite::types::Value;
use sidekicks_search::index::IndexRowKind;

use crate::search::index::columns::{index_row_kind_of, source_rowid_of};
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement};
use sidekicks_store::database::stored_column::text_column;

const NEWEST_ENTRY_SQL: &str = "SELECT max(id) FROM session_search_rowid_floors";

const FLOORS_SINCE_SQL: &str = "SELECT kind, min(highest_rowid) AS highest_rowid
  FROM session_search_rowid_floors
 WHERE id > ? GROUP BY kind";

/// The SQL of the trigger that logs `table`'s highest rowid when a delete lowers it.
pub(crate) fn rowid_floor_trigger_sql(table: &str, kind: IndexRowKind) -> String {
    let kind = <&'static str>::from(kind);
    let highest_rowid = format!("coalesce((SELECT max(rowid) FROM {table}), 0)");
    format!(
        "
CREATE TRIGGER trg_session_search_{kind}_floor AFTER DELETE ON {table}
WHEN OLD.rowid > {highest_rowid}
BEGIN
  INSERT INTO session_search_rowid_floors (kind, highest_rowid)
  VALUES ('{kind}', {highest_rowid});
END;"
    )
}

/// Lets go of the log's entries up to `position`, which no held search reads past any more.
pub(crate) fn floors_let_go_statement(position: i64) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed("DELETE FROM session_search_rowid_floors WHERE id <= ?"),
        bindings: StatementBindings::Positional(vec![Value::Integer(position)]),
        expected_row_count: None,
    }
}

/// Whether an index row still names the source row a held view indexed: the lowest highest rowid
/// logged for each kind since the view's database state, `None` for a kind with none logged.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct HeldRowCheck {
    event: Option<i64>,
    title: Option<i64>,
    group: Option<i64>,
    tag: Option<i64>,
}

impl HeldRowCheck {
    /// Whether the index row with this key still names the source row the held view indexed.
    pub(crate) fn is_held(&self, key: u64) -> bool {
        self.floor_of(index_row_kind_of(key)).is_none_or(|floor| {
            u64::try_from(floor).is_ok_and(|floor| source_rowid_of(key) <= floor)
        })
    }

    fn floor_of(&self, kind: IndexRowKind) -> Option<i64> {
        match kind {
            IndexRowKind::Event => self.event,
            IndexRowKind::Title => self.title,
            IndexRowKind::Group => self.group,
            IndexRowKind::Tag => self.tag,
        }
    }

    fn floor_mut(&mut self, kind: IndexRowKind) -> &mut Option<i64> {
        match kind {
            IndexRowKind::Event => &mut self.event,
            IndexRowKind::Title => &mut self.title,
            IndexRowKind::Group => &mut self.group,
            IndexRowKind::Tag => &mut self.tag,
        }
    }
}

/// Reads the log of lowered highest rowids on one connection. A stored value that does not read
/// as its type fails the read with rusqlite's error, keeping why.
pub(crate) struct RowidFloorLog<'connection> {
    /// The connection the log is read on.
    reader: &'connection Connection,
}

impl<'connection> RowidFloorLog<'connection> {
    /// A log reader over `reader`.
    pub(crate) fn new(reader: &'connection Connection) -> Self {
        Self { reader }
    }

    /// Where the log stands in the connection's current read.
    pub(crate) fn position(&self) -> rusqlite::Result<i64> {
        let newest: Option<i64> = self
            .reader
            .prepare_cached(NEWEST_ENTRY_SQL)?
            .query_row([], |row| row.get(0))?;
        Ok(newest.unwrap_or(0))
    }

    /// The check of the rows a view of the database at `position` indexed; `None` when no floor
    /// was logged since, as every row the view indexed is then still that row.
    pub(crate) fn held_row_check(&self, position: i64) -> rusqlite::Result<Option<HeldRowCheck>> {
        let mut statement = self.reader.prepare_cached(FLOORS_SINCE_SQL)?;
        let floors = statement.query_map([position], |row| {
            Ok((
                text_column(row, 0, |word| word.parse::<IndexRowKind>())?,
                row.get::<_, i64>(1)?,
            ))
        })?;
        let mut check = HeldRowCheck::default();
        let mut is_any_logged = false;
        for floor in floors {
            let (kind, highest_rowid) = floor?;
            *check.floor_mut(kind) = Some(highest_rowid);
            is_any_logged = true;
        }
        Ok(is_any_logged.then_some(check))
    }
}

/// The places in the floor log the searches being read stand at, a first page among them before
/// its search is held, so the entries a page in flight relies on are kept. Shared by `Arc`.
#[derive(Default)]
pub(crate) struct FloorPositionsInFlight {
    /// Each place a search being read stands at, with how many stand there.
    positions: Mutex<BTreeMap<i64, usize>>,
}

impl FloorPositionsInFlight {
    /// Enters a search at the place `read_position` answers, read under the lock [`Self::oldest`]
    /// takes: a kept floor reads the searches after the place it keeps from has moved, so a
    /// search entered before that read is counted and one entered after it reads the moved place.
    /// The search leaves when the answer drops.
    pub(crate) fn enter(
        self: &Arc<Self>,
        read_position: impl FnOnce() -> i64,
    ) -> FloorPositionInFlight {
        let mut positions = self.lock_positions();
        let position = read_position();
        *positions.entry(position).or_default() += 1;
        FloorPositionInFlight {
            positions: Arc::clone(self),
            position,
        }
    }

    /// The lowest place a search being read stands at; `None` while none is read.
    pub(crate) fn oldest(&self) -> Option<i64> {
        self.lock_positions().keys().next().copied()
    }

    fn lock_positions(&self) -> MutexGuard<'_, BTreeMap<i64, usize>> {
        // The counts hold no invariant a panicking holder could break.
        lock(&self.positions)
    }
}

/// One search being read, at its place in the floor log, until it drops.
pub(crate) struct FloorPositionInFlight {
    positions: Arc<FloorPositionsInFlight>,
    position: i64,
}

impl FloorPositionInFlight {
    /// The place in the floor log the search reads from.
    pub(crate) fn position(&self) -> i64 {
        self.position
    }
}

impl Drop for FloorPositionInFlight {
    fn drop(&mut self) {
        let mut positions = self.positions.lock_positions();
        let count = positions
            .get_mut(&self.position)
            .expect("an entered search's place is counted until it leaves");
        *count -= 1;
        if *count == 0 {
            positions.remove(&self.position);
        }
    }
}
