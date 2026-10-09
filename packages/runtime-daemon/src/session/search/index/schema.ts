// The search index's part of the daemon's schema: the outbox that feeds the index from the writes
// that change searchable text, and the log of lowered highest rowids a held search reads its rows
// against. The daemon's schema script runs it with the rest.

import type { IndexRowKind } from "@ai-sidekicks/search-index";

import { sqlListOf } from "../../../database/sql-list.js";
import { DAMAGED_EVENTS_SKIPPED_TYPE } from "../../../events/session/skipped-ranges.js";
import { rowidFloorTriggerSql } from "../rowid-floors.js";
import { INDEX_ROW_KINDS, indexKeySql } from "./columns.js";
import { OutboxOperation } from "./outbox.js";
import { INDEXED_EVENT_TYPES_SQL } from "./rows.js";

// The outbox row a trigger writes, from the SQL of each of its columns.
function outboxInsertSql(entry: {
  readonly indexKeySql: string;
  readonly kind: IndexRowKind;
  readonly ownerKeySql: string;
  readonly operation: OutboxOperation;
}): string {
  return `INSERT INTO session_search_outbox (index_key, kind, owner_key, operation)
  VALUES (${entry.indexKeySql}, '${entry.kind}', ${entry.ownerKeySql}, '${entry.operation}');`;
}

// The outbox row that has the members of the group whose id is `groupIdSql` read again; none when
// no such group is left.
function groupMembersOutboxSql(groupIdSql: string): string {
  return `INSERT INTO session_search_outbox (index_key, kind, owner_key, operation)
  SELECT ${indexKeySql("session_group.rowid", "group")}, 'group', session_group.rowid,
         '${OutboxOperation.Members}'
    FROM session_groups AS session_group WHERE session_group.id = ${groupIdSql};`;
}

// The outbox row that has a log or tag row read again, owned by the session whose id is
// `sessionIdSql`; none for a session with no directory row, whose rows the index never holds.
function sessionRowOutboxSql(rowKeySql: string, kind: IndexRowKind, sessionIdSql: string): string {
  return `INSERT INTO session_search_outbox (index_key, kind, owner_key, operation)
  SELECT ${rowKeySql}, '${kind}', session.rowid, '${OutboxOperation.Row}'
    FROM sessions AS session WHERE session.id = ${sessionIdSql};`;
}

/** The search index's part of the daemon's schema: its tables, and the triggers that write them. */
export const SEARCH_INDEX_SCHEMA_SQL: string = `
-- The search index's outbox. The index, a folder beside this database, holds settled message text,
-- tool calls, session titles, group names and tags, archived sessions included; this database stays
-- the record, and every write that changes what the index holds adds outbox rows in its own
-- transaction, through the triggers below. The search thread applies the rows in batches, each one
-- durable commit of the index that records the batch's highest id, then deletes the rows up to it
-- through the database writer; after a crash it applies the rows past the id the index recorded.
-- No text is copied here: a batch reads each row's text as this database holds it then, and a row
-- gone by then leaves the index. AUTOINCREMENT, so an id is never used twice and the id an index
-- records always means the same row.
-- index_key is the index row's key: its source row's rowid times four plus its kind's slot (event
-- 0, title 1, group 2, tag 3). owner_key is the session's rowid in sessions, or for a group's row
-- the group's rowid in session_groups. Nothing vacuums this database, so those rowids never move.
-- operation is 'row' to read the row at index_key again, 'owner' when the session or group whose
-- row is at index_key is deleted with every row it owns, and 'members' to read the group's members
-- again.
CREATE TABLE session_search_outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  index_key  INTEGER NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN (${sqlListOf(INDEX_ROW_KINDS)})),
  owner_key  INTEGER NOT NULL,
  operation  TEXT NOT NULL CHECK (operation IN (${sqlListOf(Object.values(OutboxOperation))}))
) STRICT;

-- Settled rows only, as they are appended. A purge deletes a session's log rows with its directory
-- row, whose trigger takes every row the session owns out; a repair of the database file rewrites
-- log rows with no outbox row and drops the whole index, which is built again.
CREATE TRIGGER trg_session_search_event_insert AFTER INSERT ON session_events
WHEN NEW.type IN (${INDEXED_EVENT_TYPES_SQL})
BEGIN
  ${sessionRowOutboxSql(indexKeySql("NEW.rowid", "event"), "event", "NEW.session_id")}
END;

-- A damaged session continued from its last good point skips a range of its log that no read takes
-- again, so each settled row in it is read again, and found gone.
CREATE TRIGGER trg_session_search_events_skipped AFTER INSERT ON session_events
WHEN NEW.type = '${DAMAGED_EVENTS_SKIPPED_TYPE}'
BEGIN
  INSERT INTO session_search_outbox (index_key, kind, owner_key, operation)
  SELECT ${indexKeySql("skipped.rowid", "event")}, 'event', session.rowid, '${OutboxOperation.Row}'
    FROM session_events AS skipped
    JOIN sessions AS session ON session.id = skipped.session_id
   WHERE skipped.session_id = NEW.session_id
     AND skipped.type IN (${INDEXED_EVENT_TYPES_SQL})
     AND skipped.sequence BETWEEN json_extract(NEW.payload, '$.fromSequence')
                              AND json_extract(NEW.payload, '$.toSequence');
END;

CREATE TRIGGER trg_session_search_session_insert AFTER INSERT ON sessions
BEGIN
  INSERT INTO session_search_outbox (index_key, kind, owner_key, operation)
  SELECT ${indexKeySql("NEW.rowid", "title")}, 'title', NEW.rowid, '${OutboxOperation.Row}'
   WHERE NEW.name IS NOT NULL;
  ${groupMembersOutboxSql("NEW.group_id")}
END;

CREATE TRIGGER trg_session_search_title_update AFTER UPDATE OF name ON sessions
WHEN OLD.name IS NOT NEW.name
BEGIN
  ${outboxInsertSql({
    indexKeySql: indexKeySql("NEW.rowid", "title"),
    kind: "title",
    ownerKeySql: "NEW.rowid",
    operation: OutboxOperation.Row,
  })}
END;

-- A session moving between groups changes which sessions each group's name counts toward.
CREATE TRIGGER trg_session_search_group_move AFTER UPDATE OF group_id ON sessions
WHEN OLD.group_id IS NOT NEW.group_id
BEGIN
  ${groupMembersOutboxSql("OLD.group_id")}
  ${groupMembersOutboxSql("NEW.group_id")}
END;

-- A purge: the group the session sat in loses it, then the session and every row it owns leave.
CREATE TRIGGER trg_session_search_session_delete AFTER DELETE ON sessions
BEGIN
  ${groupMembersOutboxSql("OLD.group_id")}
  ${outboxInsertSql({
    indexKeySql: indexKeySql("OLD.rowid", "title"),
    kind: "title",
    ownerKeySql: "OLD.rowid",
    operation: OutboxOperation.Owner,
  })}
END;

CREATE TRIGGER trg_session_search_group_insert AFTER INSERT ON session_groups
BEGIN
  ${outboxInsertSql({
    indexKeySql: indexKeySql("NEW.rowid", "group"),
    kind: "group",
    ownerKeySql: "NEW.rowid",
    operation: OutboxOperation.Row,
  })}
END;

CREATE TRIGGER trg_session_search_group_rename AFTER UPDATE OF name ON session_groups
WHEN OLD.name IS NOT NEW.name
BEGIN
  ${outboxInsertSql({
    indexKeySql: indexKeySql("NEW.rowid", "group"),
    kind: "group",
    ownerKeySql: "NEW.rowid",
    operation: OutboxOperation.Row,
  })}
END;

CREATE TRIGGER trg_session_search_group_delete AFTER DELETE ON session_groups
BEGIN
  ${outboxInsertSql({
    indexKeySql: indexKeySql("OLD.rowid", "group"),
    kind: "group",
    ownerKeySql: "OLD.rowid",
    operation: OutboxOperation.Owner,
  })}
END;

CREATE TRIGGER trg_session_search_tag_insert AFTER INSERT ON session_tags
BEGIN
  ${sessionRowOutboxSql(indexKeySql("NEW.rowid", "tag"), "tag", "NEW.session_id")}
END;

CREATE TRIGGER trg_session_search_tag_update AFTER UPDATE OF tag ON session_tags
WHEN OLD.tag IS NOT NEW.tag
BEGIN
  ${sessionRowOutboxSql(indexKeySql("NEW.rowid", "tag"), "tag", "NEW.session_id")}
END;

CREATE TRIGGER trg_session_search_tag_delete AFTER DELETE ON session_tags
BEGIN
  ${sessionRowOutboxSql(indexKeySql("OLD.rowid", "tag"), "tag", "OLD.session_id")}
END;

-- A tag row carries its session's last activity, which orders a search by tag alone, so each move
-- of that activity has the session's tag rows read again.
CREATE TRIGGER trg_session_search_activity_move AFTER UPDATE OF last_activity_at ON sessions
WHEN OLD.last_activity_at IS NOT NEW.last_activity_at
BEGIN
  INSERT INTO session_search_outbox (index_key, kind, owner_key, operation)
  SELECT ${indexKeySql("tag.rowid", "tag")}, 'tag', NEW.rowid, '${OutboxOperation.Row}'
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
${rowidFloorTriggerSql("session_events", "event")}
${rowidFloorTriggerSql("sessions", "title")}
${rowidFloorTriggerSql("session_groups", "group")}
${rowidFloorTriggerSql("session_tags", "tag")}
`;
