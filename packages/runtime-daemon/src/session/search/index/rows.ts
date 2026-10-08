// The text the search index holds for each source row, read from the database as it is now: a
// settled message's text, a tool call's name and arguments, a session's title, a group's name and a
// tag, with a tag's fold and its session's last activity beside it. The outbox applier, the rebuild
// and the hit reader all read rows here, so a hit's line is marked on the same text the index saw.
// A log row belongs to its session through the session's directory row; a log row of a session
// with none, which only the daemon's own sentinel session lacks, is no index row.

import type { Database, Statement } from "better-sqlite3";

import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";
import type { IndexRow, IndexRowKind, IndexRowTag } from "@ai-sidekicks/search-index";

import { indexKeySql, indexRowKindOf, sourceRowidOf } from "./columns.js";

// The log rows the index holds: a person's message, an assistant's message and a tool call, each
// stored once settled. A thinking update is narration a later event supersedes, so it is never
// indexed.
const INDEXED_EVENT_TYPES: readonly SessionEventType[] = [
  "user.message",
  "assistant.message",
  "tool.invoked",
];

/**
 * The log rows the index holds, as a SQL list: a person's message, an assistant's message and a
 * tool call, each stored once settled, never a thinking update or a streamed chunk.
 */
export const INDEXED_EVENT_TYPES_SQL: string = INDEXED_EVENT_TYPES.map((type) => `'${type}'`).join(
  ", ",
);

/**
 * The most outbox rows one batch handed to the index carries, and the most rows of one kind a build
 * reads at a time. A durable commit costs about the same whatever its size, so a batch takes as many
 * rows as the search thread's memory comfortably holds.
 */
export const INDEX_BATCH_ROW_LIMIT = 50_000;

/**
 * The text, in UTF-16 code units, past which a batch handed to the index takes no further rows:
 * 16 MiB as JavaScript holds it, so a batch of long messages stays near that on the search thread.
 */
export const INDEX_BATCH_TEXT_LIMIT: number = 8 * 1024 * 1024;

/** A source row as the index holds it, and where a log row sits in its session's log. */
export interface SourceRow {
  readonly key: number;
  readonly kind: IndexRowKind;
  /** The session the row belongs to; for a group's name, the group. */
  readonly ownerKey: number;
  readonly text: string;
  /** A log row's id and position in its session's log; `undefined` on a title, group or tag. */
  readonly logRow: { readonly eventId: string; readonly sequence: number } | undefined;
  /** A tag row's fold and its session's last activity; `undefined` on every other row. */
  readonly tag: { readonly fold: string; readonly sessionLastActivityAt: string } | undefined;
}

// A log row's text: a person's words, an assistant's reply, or a tool's name then its arguments.
const EVENT_TEXT_SQL = `CASE event.type
           WHEN 'user.message' THEN json_extract(event.payload, '$.message')
           WHEN 'assistant.message' THEN event.content_payload
           WHEN 'tool.invoked' THEN json_extract(event.payload, '$.toolName')
             || coalesce(' ' || event.content_payload, '')
         END`;

// How a read chooses its rows: the rows at some keys, or the next rows in order within a range of
// rowids.
type RowChoice = "keys" | "between";

// The condition and order that choose a read's rows by the source table's rowid, `rowidSql`.
function chosenRowsSql(choice: RowChoice, rowidSql: string): string {
  return choice === "keys"
    ? `AND ${rowidSql} IN (SELECT value FROM json_each(@rowids))`
    : `AND ${rowidSql} > @afterRowid AND ${rowidSql} <= @throughRowid
       ORDER BY ${rowidSql} LIMIT ${String(INDEX_BATCH_ROW_LIMIT)}`;
}

// Each kind's source table's highest rowid.
const LAST_ROWID_SQL_BY_KIND: Readonly<Record<IndexRowKind, string>> = {
  event: "SELECT max(rowid) FROM session_events",
  title: "SELECT max(rowid) FROM sessions",
  group: "SELECT max(rowid) FROM session_groups",
  tag: "SELECT max(rowid) FROM session_tags",
};

// The columns a row other than a tag holds none of.
const NO_TAG_SQL = "NULL AS tag_fold, NULL AS session_last_activity_at";

// Each kind's rows: the key, the owner's key, the text and, for a log row, its id and position,
// and for a tag, its fold and its session's last activity.
const ROW_SQL_BY_KIND: Readonly<Record<IndexRowKind, (choice: RowChoice) => string>> = {
  event: (choice) => `
    SELECT ${indexKeySql("event.rowid", "event")} AS key, session.rowid AS owner_key,
           ${EVENT_TEXT_SQL} AS text, event.id AS event_id, event.sequence, ${NO_TAG_SQL}
      FROM session_events AS event
      JOIN sessions AS session ON session.id = event.session_id
     WHERE event.type IN (${INDEXED_EVENT_TYPES_SQL}) AND (${EVENT_TEXT_SQL}) IS NOT NULL
       ${chosenRowsSql(choice, "event.rowid")}`,
  title: (choice) => `
    SELECT ${indexKeySql("rowid", "title")} AS key, rowid AS owner_key, name AS text,
           NULL AS event_id, NULL AS sequence, ${NO_TAG_SQL}
      FROM sessions
     WHERE name IS NOT NULL ${chosenRowsSql(choice, "rowid")}`,
  group: (choice) => `
    SELECT ${indexKeySql("rowid", "group")} AS key, rowid AS owner_key, name AS text,
           NULL AS event_id, NULL AS sequence, ${NO_TAG_SQL}
      FROM session_groups
     WHERE TRUE ${chosenRowsSql(choice, "rowid")}`,
  tag: (choice) => `
    SELECT ${indexKeySql("tag.rowid", "tag")} AS key, session.rowid AS owner_key, tag.tag AS text,
           NULL AS event_id, NULL AS sequence, tag.tag_folded AS tag_fold,
           session.last_activity_at AS session_last_activity_at
      FROM session_tags AS tag
      JOIN sessions AS session ON session.id = tag.session_id
     WHERE TRUE ${chosenRowsSql(choice, "tag.rowid")}`,
};

interface SourceRowColumns {
  readonly key: number;
  readonly owner_key: number;
  readonly text: string;
  readonly event_id: string | null;
  readonly sequence: number | null;
  readonly tag_fold: string | null;
  readonly session_last_activity_at: string | null;
}

// One statement per kind, all choosing their rows the same way.
type RowStatements<Bindings extends object> = Readonly<
  Record<IndexRowKind, Statement<Bindings, SourceRowColumns>>
>;

function prepareRowStatements<Bindings extends object>(
  reader: Database,
  choice: RowChoice,
): RowStatements<Bindings> {
  const prepare = (kind: IndexRowKind): Statement<Bindings, SourceRowColumns> =>
    reader.prepare<Bindings, SourceRowColumns>(ROW_SQL_BY_KIND[kind](choice));
  return {
    event: prepare("event"),
    title: prepare("title"),
    group: prepare("group"),
    tag: prepare("tag"),
  };
}

/** Reads index rows from their source tables on one connection. */
export class IndexRowReader {
  readonly #reader: Database;
  readonly #byKeys: RowStatements<{ rowids: string }>;
  readonly #between: RowStatements<{ afterRowid: number; throughRowid: number }>;

  constructor(reader: Database) {
    this.#reader = reader;
    this.#byKeys = prepareRowStatements(reader, "keys");
    this.#between = prepareRowStatements(reader, "between");
  }

  /** The highest rowid of the `kind` rows' source table, 0 when it holds none. */
  lastRowid(kind: IndexRowKind): number {
    return this.#reader.prepare<[], number | null>(LAST_ROWID_SQL_BY_KIND[kind]).pluck().get() ?? 0;
  }

  /**
   * The rows at these keys as the database holds them now, by key. A key whose row is gone, or no
   * longer holds text, has none.
   */
  readRows(keys: readonly number[]): Map<number, SourceRow> {
    const rowidsByKind = new Map<IndexRowKind, number[]>();
    for (const key of keys) {
      const kind = indexRowKindOf(key);
      const rowids = rowidsByKind.get(kind) ?? [];
      rowids.push(sourceRowidOf(key));
      rowidsByKind.set(kind, rowids);
    }
    const rows = new Map<number, SourceRow>();
    for (const [kind, rowids] of rowidsByKind) {
      for (const columns of this.#byKeys[kind].iterate({ rowids: JSON.stringify(rowids) })) {
        rows.set(columns.key, sourceRowOf(kind, columns));
      }
    }
    return rows;
  }

  /**
   * The `kind` rows past the source rowid `afterRowid` through `throughRowid`, in rowid order: at
   * most {@link INDEX_BATCH_ROW_LIMIT}, and no more once their text passes
   * {@link INDEX_BATCH_TEXT_LIMIT}. None once every row in the range has been read.
   */
  readRowsBetween(kind: IndexRowKind, afterRowid: number, throughRowid: number): SourceRow[] {
    const rows: SourceRow[] = [];
    let textLength = 0;
    for (const columns of this.#between[kind].iterate({ afterRowid, throughRowid })) {
      rows.push(sourceRowOf(kind, columns));
      textLength += columns.text.length;
      if (textLength > INDEX_BATCH_TEXT_LIMIT) {
        break;
      }
    }
    return rows;
  }
}

/** The row as the index takes it, a tag's session's last activity in milliseconds. */
export function indexRowOf(row: SourceRow): IndexRow {
  const indexRow = { key: row.key, kind: row.kind, ownerKey: row.ownerKey, text: row.text };
  if (row.tag === undefined) {
    return indexRow;
  }
  const tag: IndexRowTag = {
    fold: row.tag.fold,
    sessionLastActivityMs: Date.parse(row.tag.sessionLastActivityAt),
  };
  return { ...indexRow, tag };
}

function sourceRowOf(kind: IndexRowKind, columns: SourceRowColumns): SourceRow {
  return {
    key: columns.key,
    kind,
    ownerKey: columns.owner_key,
    text: columns.text,
    logRow:
      columns.event_id === null || columns.sequence === null
        ? undefined
        : { eventId: columns.event_id, sequence: columns.sequence },
    tag:
      columns.tag_fold === null || columns.session_last_activity_at === null
        ? undefined
        : { fold: columns.tag_fold, sessionLastActivityAt: columns.session_last_activity_at },
  };
}
