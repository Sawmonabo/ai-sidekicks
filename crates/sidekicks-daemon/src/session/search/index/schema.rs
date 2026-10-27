//! The search index's part of the daemon's schema: the outbox that feeds the index from the writes
//! that change searchable text, and the log of lowered highest rowids a held search reads its rows
//! against. The daemon's schema script runs it with the rest.

use sidekicks_search::index::IndexRowKind;

use crate::database::schema::{SESSION_EVENTS_TABLE, SchemaPart, SchemaParts};
use crate::database::sql_list::sql_list_of_every;
use crate::events::session::skipped_ranges::DAMAGED_EVENTS_SKIPPED_TYPE;
use crate::session::search::index::columns::index_key_sql;
use crate::session::search::index::outbox::OutboxOperation;
use crate::session::search::index::rows::INDEXED_EVENT_TYPES_SQL;
use crate::session::search::rowid_floors::rowid_floor_trigger_sql;

/// The command receipts' list and the search index's own part, whose triggers follow the session
/// directory's tables they watch.
pub(crate) fn schema_parts() -> SchemaParts {
    crate::mcp::schema::schema_parts()
        .with_part(SchemaPart::new("search_index", search_index_schema_sql()))
}

// The outbox row a trigger writes, from the SQL of each of its columns.
fn outbox_insert_sql(
    index_key_sql: &str,
    kind: IndexRowKind,
    owner_key_sql: &str,
    operation: OutboxOperation,
) -> String {
    let kind = <&'static str>::from(kind);
    let operation = <&'static str>::from(operation);
    format!(
        "INSERT INTO session_search_outbox (index_key, kind, owner_key, operation)
  VALUES ({index_key_sql}, '{kind}', {owner_key_sql}, '{operation}');"
    )
}

// The outbox row that has the members of the group whose id is `group_id_sql` read again; none
// when no such group is left.
fn group_members_outbox_sql(group_id_sql: &str) -> String {
    let group = <&'static str>::from(IndexRowKind::Group);
    let members = <&'static str>::from(OutboxOperation::Members);
    format!(
        "INSERT INTO session_search_outbox (index_key, kind, owner_key, operation)
  SELECT {key}, '{group}', session_group.rowid, '{members}'
    FROM session_groups AS session_group WHERE session_group.id = {group_id_sql};",
        key = index_key_sql("session_group.rowid", IndexRowKind::Group),
    )
}

// The outbox row that has a log or tag row read again, owned by the session whose id is
// `session_id_sql`; none for a session with no directory row, whose rows the index never holds.
fn session_row_outbox_sql(row_key_sql: &str, kind: IndexRowKind, session_id_sql: &str) -> String {
    let kind = <&'static str>::from(kind);
    let row = <&'static str>::from(OutboxOperation::Row);
    format!(
        "INSERT INTO session_search_outbox (index_key, kind, owner_key, operation)
  SELECT {row_key_sql}, '{kind}', session.rowid, '{row}'
    FROM sessions AS session WHERE session.id = {session_id_sql};"
    )
}

fn search_index_schema_sql() -> String {
    let kinds = sql_list_of_every::<IndexRowKind>();
    let operations = sql_list_of_every::<OutboxOperation>();
    let indexed_event_types = INDEXED_EVENT_TYPES_SQL.as_str();
    let skipped_type = DAMAGED_EVENTS_SKIPPED_TYPE.as_str();
    let event = <&'static str>::from(IndexRowKind::Event);
    let title = <&'static str>::from(IndexRowKind::Title);
    let tag = <&'static str>::from(IndexRowKind::Tag);
    let row = <&'static str>::from(OutboxOperation::Row);
    let event_insert = session_row_outbox_sql(
        &index_key_sql("NEW.rowid", IndexRowKind::Event),
        IndexRowKind::Event,
        "NEW.session_id",
    );
    let skipped_key = index_key_sql("skipped.rowid", IndexRowKind::Event);
    let title_key = index_key_sql("NEW.rowid", IndexRowKind::Title);
    let session_insert_members = group_members_outbox_sql("NEW.group_id");
    let title_update = outbox_insert_sql(
        &index_key_sql("NEW.rowid", IndexRowKind::Title),
        IndexRowKind::Title,
        "NEW.rowid",
        OutboxOperation::Row,
    );
    let old_group_members = group_members_outbox_sql("OLD.group_id");
    let new_group_members = group_members_outbox_sql("NEW.group_id");
    let session_delete = outbox_insert_sql(
        &index_key_sql("OLD.rowid", IndexRowKind::Title),
        IndexRowKind::Title,
        "OLD.rowid",
        OutboxOperation::Owner,
    );
    let group_row = outbox_insert_sql(
        &index_key_sql("NEW.rowid", IndexRowKind::Group),
        IndexRowKind::Group,
        "NEW.rowid",
        OutboxOperation::Row,
    );
    let group_delete = outbox_insert_sql(
        &index_key_sql("OLD.rowid", IndexRowKind::Group),
        IndexRowKind::Group,
        "OLD.rowid",
        OutboxOperation::Owner,
    );
    let new_tag_row = session_row_outbox_sql(
        &index_key_sql("NEW.rowid", IndexRowKind::Tag),
        IndexRowKind::Tag,
        "NEW.session_id",
    );
    let old_tag_row = session_row_outbox_sql(
        &index_key_sql("OLD.rowid", IndexRowKind::Tag),
        IndexRowKind::Tag,
        "OLD.session_id",
    );
    let activity_tag_key = index_key_sql("tag.rowid", IndexRowKind::Tag);
    let event_floor = rowid_floor_trigger_sql(SESSION_EVENTS_TABLE, IndexRowKind::Event);
    let title_floor = rowid_floor_trigger_sql("sessions", IndexRowKind::Title);
    let group_floor = rowid_floor_trigger_sql("session_groups", IndexRowKind::Group);
    let tag_floor = rowid_floor_trigger_sql("session_tags", IndexRowKind::Tag);
    format!(
        "
-- The search index's outbox. The index, a folder beside this database, holds settled message text,
-- tool calls, session titles, group names and tags, archived sessions included; this database stays
-- the record, and every write that changes what the index holds adds outbox rows in its own
-- transaction, through the triggers below. The daemon applies the rows in batches, each one durable
-- commit of the index that records the batch's highest id, then deletes the rows up to it through
-- the database writer; after a crash it applies the rows past the id the index recorded.
-- No text is copied here: a batch reads each row's text as this database holds it then, and a row
-- gone by then leaves the index. AUTOINCREMENT, so an id is never used twice and the id an index
-- records always means the same row.
-- index_key is the index row's key: its source row's rowid times four plus its kind's slot (event
-- 0, title 1, group 2, tag 3). owner_key is the session's rowid in sessions, or for a group's row
-- the group's rowid in session_groups. Each of the four source tables declares its rowid as its
-- INTEGER PRIMARY KEY, so the repack's VACUUM keeps every rowid and no key moves.
-- operation is 'row' to read the row at index_key again, 'owner' when the session or group whose
-- row is at index_key is deleted with every row it owns, and 'members' to read the group's members
-- again.
CREATE TABLE session_search_outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  index_key  INTEGER NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ({kinds})),
  owner_key  INTEGER NOT NULL,
  operation  TEXT NOT NULL CHECK (operation IN ({operations}))
) STRICT;

-- Settled rows only, as they are appended. A purge deletes a session's log rows with its directory
-- row, whose trigger takes every row the session owns out; a repair of the database file drops the
-- whole index, which is built again from the repaired rows, whether they left an outbox row or
-- not.
CREATE TRIGGER trg_session_search_event_insert AFTER INSERT ON {SESSION_EVENTS_TABLE}
WHEN NEW.type IN ({indexed_event_types})
BEGIN
  {event_insert}
END;

-- A damaged session continued from its last good point skips a range of its log that no read takes
-- again, so each settled row in it is read again, and found gone.
CREATE TRIGGER trg_session_search_events_skipped AFTER INSERT ON {SESSION_EVENTS_TABLE}
WHEN NEW.type = '{skipped_type}'
BEGIN
  INSERT INTO session_search_outbox (index_key, kind, owner_key, operation)
  SELECT {skipped_key}, '{event}', session.rowid, '{row}'
    FROM {SESSION_EVENTS_TABLE} AS skipped
    JOIN sessions AS session ON session.id = skipped.session_id
   WHERE skipped.session_id = NEW.session_id
     AND skipped.type IN ({indexed_event_types})
     AND skipped.sequence BETWEEN json_extract(NEW.payload, '$.fromSequence')
                              AND json_extract(NEW.payload, '$.toSequence');
END;

CREATE TRIGGER trg_session_search_session_insert AFTER INSERT ON sessions
BEGIN
  INSERT INTO session_search_outbox (index_key, kind, owner_key, operation)
  SELECT {title_key}, '{title}', NEW.rowid, '{row}'
   WHERE NEW.name IS NOT NULL;
  {session_insert_members}
END;

CREATE TRIGGER trg_session_search_title_update AFTER UPDATE OF name ON sessions
WHEN OLD.name IS NOT NEW.name
BEGIN
  {title_update}
END;

-- A session moving between groups changes which sessions each group's name counts toward.
CREATE TRIGGER trg_session_search_group_move AFTER UPDATE OF group_id ON sessions
WHEN OLD.group_id IS NOT NEW.group_id
BEGIN
  {old_group_members}
  {new_group_members}
END;

-- A purge: the group the session sat in loses it, then the session and every row it owns leave.
CREATE TRIGGER trg_session_search_session_delete AFTER DELETE ON sessions
BEGIN
  {old_group_members}
  {session_delete}
END;

CREATE TRIGGER trg_session_search_group_insert AFTER INSERT ON session_groups
BEGIN
  {group_row}
END;

CREATE TRIGGER trg_session_search_group_rename AFTER UPDATE OF name ON session_groups
WHEN OLD.name IS NOT NEW.name
BEGIN
  {group_row}
END;

CREATE TRIGGER trg_session_search_group_delete AFTER DELETE ON session_groups
BEGIN
  {group_delete}
END;

CREATE TRIGGER trg_session_search_tag_insert AFTER INSERT ON session_tags
BEGIN
  {new_tag_row}
END;

CREATE TRIGGER trg_session_search_tag_update AFTER UPDATE OF tag ON session_tags
WHEN OLD.tag IS NOT NEW.tag
BEGIN
  {new_tag_row}
END;

CREATE TRIGGER trg_session_search_tag_delete AFTER DELETE ON session_tags
BEGIN
  {old_tag_row}
END;

-- A tag row carries its session's last activity, which orders a search by tag alone, so each move
-- of that activity has the session's tag rows read again.
CREATE TRIGGER trg_session_search_activity_move AFTER UPDATE OF last_activity_at ON sessions
WHEN OLD.last_activity_at IS NOT NEW.last_activity_at
BEGIN
  INSERT INTO session_search_outbox (index_key, kind, owner_key, operation)
  SELECT {activity_tag_key}, '{tag}', NEW.rowid, '{row}'
    FROM session_tags AS tag WHERE tag.session_id = NEW.id;
END;

-- Each delete that lowers an indexed source table's highest rowid, with the new highest (0 for an
-- empty table), so a held search can tell the rowids a later row may have taken since its view.
-- kind names the index rows the table's rows source. AUTOINCREMENT, so an entry written after a
-- held search's place in the log always sits past it, even once older entries are let go.
CREATE TABLE session_search_rowid_floors (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL,
  highest_rowid  INTEGER NOT NULL
) STRICT;
{event_floor}
{title_floor}
{group_floor}
{tag_floor}
"
    )
}

/// Writes a titled session with the id `session_id` on a test's `connection` holding the daemon's
/// schema, whose insert gives the outbox its rows, and answers the outbox's highest id after it.
#[cfg(test)]
pub(crate) fn add_titled_session(connection: &rusqlite::Connection, session_id: &str) -> u64 {
    crate::database::schema::session_directory::insert_session_row(
        connection,
        session_id,
        Some("Billing fix"),
        None,
    );
    crate::session::search::index::outbox::OutboxReader::new(connection)
        .highest_id_given()
        .expect("the outbox's highest id reads")
}
