# Session Search Index Tables (ADR-041)

The session search index's tables of the daemon's one SQLite schema: the outbox that feeds the full-text index from every write that changes searchable text, the log of lowered highest rowids a held search reads its rows against, and the triggers that write them. The [Local SQLite Schema](local-sqlite-schema.md) holds its pragmas, its conventions and every other area.

## Session Search Index

The search across every session and a session's own find are answered from the daemon's own full-text index on Tantivy over session titles, message text, tool calls, group names and tags. The index lives outside this database and is built from it: every write that changes searchable text adds a row to an outbox table here in the same transaction, the daemon applies the outbox to the index in batches and deletes the rows each durable index commit holds, and a crash replays what the index has not committed ([ADR-041](../../decisions/041-session-search-on-tantivy.md)). It reaches every session the list holds, archived ones included, with no cap. Only settled messages are indexed, never streamed chunks; prefix fields of one to four characters serve search as the person types; and the index merges its segments on its own thread whenever the merge policy proposes a merge, after each commit and each finished merge, no merge writing more than 250,000 live rows, rewriting each segment that held a purged session's or a deleted group's rows. A `tag:<tag>` term matches the tag and every tag nested under it: the index holds each tag row under its tag's fold cut at every `/` (`billing/stripe` under `billing` and `billing/stripe`), with its session's last activity. A search with words answers in BM25 order (k1 1.2, b 0.75, a word in half or more of the rows weighted 1e-6). A tag narrows the sessions searched to those it matches and adds nothing to a score; a tag with no words lists its sessions most recently active first. Where the agents' `session_search` names a related session, the BM25 rank and the relation rank are merged by Reciprocal Rank Fusion, each list contributing 1/(60 + its rank); the person's box names no session, so `session_related` takes no part, and the person's `Search all sessions` box gets its hits grouped by session, while the agents' `session_search` gets them grouped by project, then group, then session, each branch ordered by its best score. The outbox is `session_search_outbox`, written by triggers on `session_events` (a settled message or tool call as it is appended), `sessions` (a title, a move between groups, a purge, and a move of its last activity, which re-reads the session's tag rows), `session_groups` (a name, a deletion) and `session_tags`. It copies no text: the search thread reads each row's text as this database holds it when a batch is read, at most 50,000 outbox rows or 16 MiB of text, ending a batch at a deleted session or group, and a row gone by then leaves the index. An index row's key is its source row's rowid times four plus its kind's slot (`event` 0, `title` 1, `group` 2, `tag` 3), and its owner is a session's rowid in `sessions` or, for a group name, the group's rowid in `session_groups`; each of the four source tables declares its rowid as its `INTEGER PRIMARY KEY`, so the repack's `VACUUM` keeps every rowid and no key moves. A missing or unreadable index, or one whose last applied outbox id is past any id this outbox has given (an index built from another database), is rebuilt from this database while the daemon serves, in a child process the search thread starts and waits on, so a build that crashes fails only the build and never ends the service; the build reads each source table through its highest rowid at the build's start, a later row reaching the index through the outbox, each batch holding every kind's rows through the same share of its table, then merges its segments, and the search thread then opens it. A search's later pages read the index as its first page did; because a source table gives a deleted row's rowid to the next row it inserts, `session_search_rowid_floors` logs every delete that lowers an indexed table's highest rowid, with the new highest, and a later page credits a held row only while its source rowid is no higher than every highest rowid logged since that view, so a row at a rowid a later row took is passed over like a purged one. The source tables insert without naming a rowid and never `REPLACE`, whose deletes fire no trigger. A held search is let go after 5 minutes unpaged or 30 minutes in all, and past 16 held the least recently paged goes first; a cursor of a search let go is refused `session.search.cursorUnresolvable`.

```sql
CREATE TABLE session_search_outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,  -- never reused, so the id an index commit records always means the same row
  index_key  INTEGER NOT NULL,                   -- source rowid * 4 + the kind's slot
  kind       TEXT NOT NULL CHECK (kind IN ('event', 'title', 'group', 'tag')),
  owner_key  INTEGER NOT NULL,                   -- sessions.rowid, or session_groups.rowid for a group name
  -- 'row': read the row at index_key again; 'owner': the session or group at index_key left with
  -- every row it owns; 'members': read the group's members again
  operation  TEXT NOT NULL CHECK (operation IN ('row', 'owner', 'members'))
) STRICT;

-- A settled message or tool call, as it is appended.
CREATE TRIGGER trg_session_search_event_insert AFTER INSERT ON session_events
WHEN NEW.type IN ('user.message.sent', 'agent.message.sent', 'agent.toolCall.invoked')
BEGIN
  INSERT INTO session_search_outbox (index_key, kind, owner_key, operation)
  SELECT (NEW.rowid * 4 + 0), 'event', session.rowid, 'row'
    FROM sessions AS session WHERE session.id = NEW.session_id;
END;

-- A damaged session continued from its last good point skips a range of its log that no read takes
-- again, so each settled row in it is read again, and found gone.
CREATE TRIGGER trg_session_search_events_skipped AFTER INSERT ON session_events
WHEN NEW.type = 'session.damagedEvents.skipped'
BEGIN
  INSERT INTO session_search_outbox (index_key, kind, owner_key, operation)
  SELECT (skipped.rowid * 4 + 0), 'event', session.rowid, 'row'
    FROM session_events AS skipped
    JOIN sessions AS session ON session.id = skipped.session_id
   WHERE skipped.session_id = NEW.session_id
     AND skipped.type IN ('user.message.sent', 'agent.message.sent', 'agent.toolCall.invoked')
     AND skipped.sequence BETWEEN json_extract(NEW.payload, '$.fromSequence')
                              AND json_extract(NEW.payload, '$.toSequence');
END;

CREATE TRIGGER trg_session_search_session_insert AFTER INSERT ON sessions
BEGIN
  INSERT INTO session_search_outbox (index_key, kind, owner_key, operation)
  SELECT (NEW.rowid * 4 + 1), 'title', NEW.rowid, 'row'
   WHERE NEW.name IS NOT NULL;
  INSERT INTO session_search_outbox (index_key, kind, owner_key, operation)
  SELECT (session_group.rowid * 4 + 2), 'group', session_group.rowid, 'members'
    FROM session_groups AS session_group WHERE session_group.id = NEW.group_id;
END;

CREATE TRIGGER trg_session_search_title_update AFTER UPDATE OF name ON sessions
WHEN OLD.name IS NOT NEW.name
BEGIN
  INSERT INTO session_search_outbox (index_key, kind, owner_key, operation)
  VALUES ((NEW.rowid * 4 + 1), 'title', NEW.rowid, 'row');
END;

-- A session moving between groups changes which sessions each group's name counts toward.
CREATE TRIGGER trg_session_search_group_move AFTER UPDATE OF group_id ON sessions
WHEN OLD.group_id IS NOT NEW.group_id
BEGIN
  INSERT INTO session_search_outbox (index_key, kind, owner_key, operation)
  SELECT (session_group.rowid * 4 + 2), 'group', session_group.rowid, 'members'
    FROM session_groups AS session_group WHERE session_group.id = OLD.group_id;
  INSERT INTO session_search_outbox (index_key, kind, owner_key, operation)
  SELECT (session_group.rowid * 4 + 2), 'group', session_group.rowid, 'members'
    FROM session_groups AS session_group WHERE session_group.id = NEW.group_id;
END;

-- A purge: the group the session sat in loses it, then the session and every row it owns leave.
CREATE TRIGGER trg_session_search_session_delete AFTER DELETE ON sessions
BEGIN
  INSERT INTO session_search_outbox (index_key, kind, owner_key, operation)
  SELECT (session_group.rowid * 4 + 2), 'group', session_group.rowid, 'members'
    FROM session_groups AS session_group WHERE session_group.id = OLD.group_id;
  INSERT INTO session_search_outbox (index_key, kind, owner_key, operation)
  VALUES ((OLD.rowid * 4 + 1), 'title', OLD.rowid, 'owner');
END;

CREATE TRIGGER trg_session_search_group_insert AFTER INSERT ON session_groups
BEGIN
  INSERT INTO session_search_outbox (index_key, kind, owner_key, operation)
  VALUES ((NEW.rowid * 4 + 2), 'group', NEW.rowid, 'row');
END;
CREATE TRIGGER trg_session_search_group_rename AFTER UPDATE OF name ON session_groups
WHEN OLD.name IS NOT NEW.name
BEGIN
  INSERT INTO session_search_outbox (index_key, kind, owner_key, operation)
  VALUES ((NEW.rowid * 4 + 2), 'group', NEW.rowid, 'row');
END;
CREATE TRIGGER trg_session_search_group_delete AFTER DELETE ON session_groups
BEGIN
  INSERT INTO session_search_outbox (index_key, kind, owner_key, operation)
  VALUES ((OLD.rowid * 4 + 2), 'group', OLD.rowid, 'owner');
END;

CREATE TRIGGER trg_session_search_tag_insert AFTER INSERT ON session_tags
BEGIN
  INSERT INTO session_search_outbox (index_key, kind, owner_key, operation)
  SELECT (NEW.rowid * 4 + 3), 'tag', session.rowid, 'row'
    FROM sessions AS session WHERE session.id = NEW.session_id;
END;
CREATE TRIGGER trg_session_search_tag_update AFTER UPDATE OF tag ON session_tags
WHEN OLD.tag IS NOT NEW.tag
BEGIN
  INSERT INTO session_search_outbox (index_key, kind, owner_key, operation)
  SELECT (NEW.rowid * 4 + 3), 'tag', session.rowid, 'row'
    FROM sessions AS session WHERE session.id = NEW.session_id;
END;
CREATE TRIGGER trg_session_search_tag_delete AFTER DELETE ON session_tags
BEGIN
  INSERT INTO session_search_outbox (index_key, kind, owner_key, operation)
  SELECT (OLD.rowid * 4 + 3), 'tag', session.rowid, 'row'
    FROM sessions AS session WHERE session.id = OLD.session_id;
END;

-- A tag row carries its session's last activity, which orders a search by tag alone, so each move
-- of that activity has the session's tag rows read again.
CREATE TRIGGER trg_session_search_activity_move AFTER UPDATE OF last_activity_at ON sessions
WHEN OLD.last_activity_at IS NOT NEW.last_activity_at
BEGIN
  INSERT INTO session_search_outbox (index_key, kind, owner_key, operation)
  SELECT (tag.rowid * 4 + 3), 'tag', NEW.rowid, 'row'
    FROM session_tags AS tag WHERE tag.session_id = NEW.id;
END;

CREATE TABLE session_search_rowid_floors (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL,                  -- the index rows the table's rows source
  highest_rowid  INTEGER NOT NULL                -- the table's highest rowid after the delete; 0 when empty
) STRICT;

-- Each delete that lowers an indexed source table's highest rowid logs the new highest.
CREATE TRIGGER trg_session_search_event_floor AFTER DELETE ON session_events
WHEN OLD.rowid > coalesce((SELECT max(rowid) FROM session_events), 0)
BEGIN
  INSERT INTO session_search_rowid_floors (kind, highest_rowid)
  VALUES ('event', coalesce((SELECT max(rowid) FROM session_events), 0));
END;
CREATE TRIGGER trg_session_search_title_floor AFTER DELETE ON sessions
WHEN OLD.rowid > coalesce((SELECT max(rowid) FROM sessions), 0)
BEGIN
  INSERT INTO session_search_rowid_floors (kind, highest_rowid)
  VALUES ('title', coalesce((SELECT max(rowid) FROM sessions), 0));
END;
CREATE TRIGGER trg_session_search_group_floor AFTER DELETE ON session_groups
WHEN OLD.rowid > coalesce((SELECT max(rowid) FROM session_groups), 0)
BEGIN
  INSERT INTO session_search_rowid_floors (kind, highest_rowid)
  VALUES ('group', coalesce((SELECT max(rowid) FROM session_groups), 0));
END;
CREATE TRIGGER trg_session_search_tag_floor AFTER DELETE ON session_tags
WHEN OLD.rowid > coalesce((SELECT max(rowid) FROM session_tags), 0)
BEGIN
  INSERT INTO session_search_rowid_floors (kind, highest_rowid)
  VALUES ('tag', coalesce((SELECT max(rowid) FROM session_tags), 0));
END;

-- A search by tag and words reads each tagged session's rowid and last activity from here alone.
CREATE INDEX idx_sessions_activity ON sessions(id, last_activity_at);
```
