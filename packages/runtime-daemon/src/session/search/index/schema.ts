// The full-text index's tables and triggers, which the daemon's schema script runs with the rest.

import { markFreeTextSql } from "../marked-line.js";
import { rowidFloorTriggerSql } from "../rowid-floors.js";
import { indexRowidSql, ownerKeySql } from "./columns.js";

// Run by every trigger that writes the search index, after its write.
const INDEX_VERSION_BUMP_SQL = "UPDATE session_search_index_version SET version = version + 1;";

/** The search index's part of the daemon's schema: its tables, and the triggers that keep it. */
export const SEARCH_INDEX_SCHEMA_SQL: string = `
-- The full-text index both searches read: session titles, settled message text, tool calls,
-- group names and tags, archived sessions included. Each row's rowid is its source row's rowid
-- times four plus its kind's slot (event 0, title 1, group 2, tag 3), so every trigger below
-- reaches its row by rowid. Nothing vacuums this database, so those rowids never move.
-- Words are matched in text alone. owner_key holds, as one token, the id of the row's owner: the
-- session a log, title or tag row belongs to, or the group a group row names. So a read limited to
-- some sessions and their groups reads their entries rather than every match, and every row's
-- length counts its key alike. A group row has no session_id: its sessions are read through
-- sessions.group_id. sequence is the event's position, NULL on every other kind. Text is indexed
-- with the two characters a search's highlight marks a match with turned to spaces, so every mark
-- read back is one the index put. The prefix indexes serve search as the person types; FTS5's
-- automerge keeps writes bounded, and the daemon merges the rest when idle. The tokenizer keeps
-- words apart, which the search's match count needs: it counts what highlight() marks only while
-- no two tokens share a character, and trigram's do ('abc' in 'abcabc' counts two, marked as one).
CREATE VIRTUAL TABLE session_search_index USING fts5(
  text,
  owner_key,
  session_id UNINDEXED,
  kind UNINDEXED,
  sequence UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3 4'
);

-- The index's version: every trigger below that writes the index adds one, so connections that
-- read the same version read the same index, and a ranking split across connections is one
-- ranking. The idle merges rewrite how the index is stored, never what it holds, and add nothing.
CREATE TABLE session_search_index_version (
  singleton  INTEGER PRIMARY KEY CHECK (singleton = 1),
  version    INTEGER NOT NULL
) STRICT;
INSERT INTO session_search_index_version (singleton, version) VALUES (1, 0);

-- Settled rows only: a person's message, an assistant's message and a tool call. A thinking
-- update is narration a later event supersedes, so it is never indexed.
CREATE TRIGGER trg_session_search_event_insert AFTER INSERT ON session_events
WHEN NEW.type IN ('user.message', 'assistant.message', 'tool.invoked')
BEGIN
  INSERT INTO session_search_index (rowid, text, owner_key, session_id, kind, sequence)
  SELECT ${indexRowidSql("NEW.rowid", "event")}, indexed.text, ${ownerKeySql("NEW.session_id")},
         NEW.session_id, 'event', NEW.sequence
    FROM (SELECT ${markFreeTextSql(`CASE
                   WHEN NEW.type = 'user.message' THEN json_extract(NEW.payload, '$.message')
                   WHEN NEW.type = 'assistant.message' THEN NEW.content_payload
                   WHEN NEW.type = 'tool.invoked' THEN json_extract(NEW.payload, '$.toolName')
                     || coalesce(' ' || NEW.content_payload, '')
                 END`)} AS text) AS indexed
   WHERE indexed.text IS NOT NULL;
  ${INDEX_VERSION_BUMP_SQL}
END;

CREATE TRIGGER trg_session_search_event_delete AFTER DELETE ON session_events
WHEN OLD.type IN ('user.message', 'assistant.message', 'tool.invoked')
BEGIN
  DELETE FROM session_search_index WHERE rowid = ${indexRowidSql("OLD.rowid", "event")};
  ${INDEX_VERSION_BUMP_SQL}
END;

CREATE TRIGGER trg_session_search_title_insert AFTER INSERT ON sessions
WHEN NEW.name IS NOT NULL
BEGIN
  INSERT INTO session_search_index (rowid, text, owner_key, session_id, kind)
  VALUES (${indexRowidSql("NEW.rowid", "title")}, ${markFreeTextSql("NEW.name")},
          ${ownerKeySql("NEW.id")}, NEW.id, 'title');
  ${INDEX_VERSION_BUMP_SQL}
END;

CREATE TRIGGER trg_session_search_title_update AFTER UPDATE OF name ON sessions
BEGIN
  DELETE FROM session_search_index WHERE rowid = ${indexRowidSql("OLD.rowid", "title")};
  INSERT INTO session_search_index (rowid, text, owner_key, session_id, kind)
  SELECT ${indexRowidSql("NEW.rowid", "title")}, ${markFreeTextSql("NEW.name")},
         ${ownerKeySql("NEW.id")}, NEW.id, 'title'
   WHERE NEW.name IS NOT NULL;
  ${INDEX_VERSION_BUMP_SQL}
END;

CREATE TRIGGER trg_session_search_title_delete AFTER DELETE ON sessions
BEGIN
  DELETE FROM session_search_index WHERE rowid = ${indexRowidSql("OLD.rowid", "title")};
  ${INDEX_VERSION_BUMP_SQL}
END;

CREATE TRIGGER trg_session_search_group_insert AFTER INSERT ON session_groups
BEGIN
  INSERT INTO session_search_index (rowid, text, owner_key, kind)
  VALUES (${indexRowidSql("NEW.rowid", "group")}, ${markFreeTextSql("NEW.name")},
          ${ownerKeySql("NEW.id")}, 'group');
  ${INDEX_VERSION_BUMP_SQL}
END;

CREATE TRIGGER trg_session_search_group_update AFTER UPDATE OF name ON session_groups
BEGIN
  DELETE FROM session_search_index WHERE rowid = ${indexRowidSql("OLD.rowid", "group")};
  INSERT INTO session_search_index (rowid, text, owner_key, kind)
  VALUES (${indexRowidSql("NEW.rowid", "group")}, ${markFreeTextSql("NEW.name")},
          ${ownerKeySql("NEW.id")}, 'group');
  ${INDEX_VERSION_BUMP_SQL}
END;

CREATE TRIGGER trg_session_search_group_delete AFTER DELETE ON session_groups
BEGIN
  DELETE FROM session_search_index WHERE rowid = ${indexRowidSql("OLD.rowid", "group")};
  ${INDEX_VERSION_BUMP_SQL}
END;

CREATE TRIGGER trg_session_search_tag_insert AFTER INSERT ON session_tags
BEGIN
  INSERT INTO session_search_index (rowid, text, owner_key, session_id, kind)
  VALUES (${indexRowidSql("NEW.rowid", "tag")}, ${markFreeTextSql("NEW.tag")},
          ${ownerKeySql("NEW.session_id")}, NEW.session_id, 'tag');
  ${INDEX_VERSION_BUMP_SQL}
END;

CREATE TRIGGER trg_session_search_tag_update AFTER UPDATE OF tag ON session_tags
BEGIN
  DELETE FROM session_search_index WHERE rowid = ${indexRowidSql("OLD.rowid", "tag")};
  INSERT INTO session_search_index (rowid, text, owner_key, session_id, kind)
  VALUES (${indexRowidSql("NEW.rowid", "tag")}, ${markFreeTextSql("NEW.tag")},
          ${ownerKeySql("NEW.session_id")}, NEW.session_id, 'tag');
  ${INDEX_VERSION_BUMP_SQL}
END;

CREATE TRIGGER trg_session_search_tag_delete AFTER DELETE ON session_tags
BEGIN
  DELETE FROM session_search_index WHERE rowid = ${indexRowidSql("OLD.rowid", "tag")};
  ${INDEX_VERSION_BUMP_SQL}
END;

-- Each delete that lowers an indexed source table's highest rowid, with the new highest (0 for an
-- empty table), so a search held across pages can tell the rowids a later row may have taken.
-- kind names the index rows the table's rows source. Only the newest entries are kept.
CREATE TABLE session_search_rowid_floors (
  id             INTEGER PRIMARY KEY,
  kind           TEXT NOT NULL,
  highest_rowid  INTEGER NOT NULL
) STRICT;
${rowidFloorTriggerSql("session_events", "event")}
${rowidFloorTriggerSql("sessions", "title")}
${rowidFloorTriggerSql("session_groups", "group")}
${rowidFloorTriggerSql("session_tags", "tag")}
`;
