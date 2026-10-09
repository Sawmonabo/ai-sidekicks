// Reads the search index's outbox into the batches the index applies, and deletes what the index
// has applied. A read takes the outbox rows waiting past the last one read, in id order, and reads
// in the same read transaction each row they name with its text as the database holds it then, a
// row gone by then as a removal, and each group whose members changed with its members then. A
// session or group deleted with its rows ends its batch, so rows a later session or group writes at
// a key it held always land in a later commit than the removal.

import type { Database, Statement } from "better-sqlite3";

import type {
  GroupMembers,
  IndexBatch,
  IndexRow,
  IndexRowKind,
  RemovedOwner,
} from "@ai-sidekicks/search-index";

import type { DatabaseWriter } from "../../../database/writer.js";
import { floorsLetGoStatement, type RowidFloorLog } from "../rowid-floors.js";
import {
  INDEX_BATCH_ROW_LIMIT,
  INDEX_BATCH_TEXT_LIMIT,
  indexRowOf,
  type IndexRowReader,
} from "./rows.js";

/**
 * What an outbox row asks of the index: read the row at its key again, take every row its owner
 * held out, or read its group's members again.
 */
export const OutboxOperation = { Row: "row", Owner: "owner", Members: "members" } as const;
/** One of the {@link OutboxOperation} values. */
export type OutboxOperation = (typeof OutboxOperation)[keyof typeof OutboxOperation];

interface OutboxEntry {
  readonly id: number;
  readonly index_key: number;
  readonly kind: IndexRowKind;
  readonly owner_key: number;
  readonly operation: OutboxOperation;
}

/** What one read of the outbox found. */
export interface OutboxRead {
  /** The batch to apply; `undefined` when no outbox row waits. */
  readonly batch: IndexBatch | undefined;
  /**
   * Where the rowid floor log stood at the read when the read left no outbox row waiting, so the
   * index matches the database at that point once the batch is applied; `undefined` while rows
   * wait past the batch.
   */
  readonly floorPosition: number | undefined;
}

/** The outbox rows a durable commit lets the daemon delete, and the floor log entries with them. */
export interface AppliedOutbox {
  /** The highest outbox id the index has durably applied. */
  readonly lastOutboxId: number;
  /** The highest floor log entry no held search and no newer view reads any more. */
  readonly keptFloorPosition: number;
}

const ENTRIES_SQL = `
  SELECT id, index_key, kind, owner_key, operation FROM session_search_outbox
   WHERE id > ? ORDER BY id LIMIT ${String(INDEX_BATCH_ROW_LIMIT)}`;
const IS_ENTRY_AFTER_SQL = "SELECT EXISTS (SELECT 1 FROM session_search_outbox WHERE id > ?)";
// The outbox's ids only grow, so the highest it has given is SQLite's record of its last one.
const HIGHEST_ID_GIVEN_SQL = `
  SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'session_search_outbox'), 0)`;
// A group's members in session id order, the order the index breaks ties among them in.
const GROUP_MEMBERS_SQL = `
  SELECT session.rowid FROM session_groups AS session_group
    JOIN sessions AS session ON session.group_id = session_group.id
   WHERE session_group.rowid = ? ORDER BY session.id`;
const EVERY_GROUP_MEMBER_SQL = `
  SELECT session_group.rowid AS group_key, session.rowid AS session_key
    FROM session_groups AS session_group
    JOIN sessions AS session ON session.group_id = session_group.id
   ORDER BY session_group.rowid, session.id`;
// Applied outbox rows are deleted at most this many to a write, so the deletes after a rebuild of
// a large database never hold the database writer for long.
const APPLIED_ROWS_PER_DELETE = 10_000;
const APPLIED_ROWS_DELETE_SQL = `
  DELETE FROM session_search_outbox WHERE id IN (
    SELECT id FROM session_search_outbox WHERE id <= ? ORDER BY id
     LIMIT ${String(APPLIED_ROWS_PER_DELETE)})`;

// The rows a batch names are read this many outbox rows at a time, so a batch stops within one
// such read past its text bound: a log row's stored body is at most 256 KiB.
const ROWS_READ_AT_ONCE = 32;

/** Reads the outbox on one connection. */
export class OutboxReader {
  readonly #reader: Database;
  readonly #rows: IndexRowReader;
  readonly #floorLog: RowidFloorLog;
  readonly #entries: Statement<[number], OutboxEntry>;
  readonly #isEntryAfter: Statement<[number], number>;
  readonly #highestIdGiven: Statement<[], number>;
  readonly #groupMembers: Statement<[number], number>;
  readonly #everyGroupMember: Statement<
    [],
    { readonly group_key: number; readonly session_key: number }
  >;

  constructor(reader: Database, rows: IndexRowReader, floorLog: RowidFloorLog) {
    this.#reader = reader;
    this.#rows = rows;
    this.#floorLog = floorLog;
    this.#entries = reader.prepare(ENTRIES_SQL);
    this.#isEntryAfter = reader.prepare<[number], number>(IS_ENTRY_AFTER_SQL).pluck();
    this.#highestIdGiven = reader.prepare<[], number>(HIGHEST_ID_GIVEN_SQL).pluck();
    this.#groupMembers = reader.prepare<[number], number>(GROUP_MEMBERS_SQL).pluck();
    this.#everyGroupMember = reader.prepare(EVERY_GROUP_MEMBER_SQL);
  }

  /**
   * The highest id the outbox has given, 0 before its first row. An index whose newest commit
   * records a higher one was built from another database.
   */
  highestIdGiven(): number {
    return this.#highestIdGiven.get() ?? 0;
  }

  /**
   * The next batch past the outbox id `afterId`, read in one read transaction: at most
   * {@link INDEX_BATCH_ROW_LIMIT} outbox rows, no more once their rows' text passes
   * {@link INDEX_BATCH_TEXT_LIMIT}, and none past a deleted session or group.
   */
  read(afterId: number): OutboxRead {
    return this.#reader.transaction(() => this.#read(afterId))();
  }

  /** Every group's members as the database holds them now. */
  readEveryGroupMembers(): GroupMembers[] {
    const groups: GroupMembers[] = [];
    let group: GroupMembers | undefined;
    for (const row of this.#everyGroupMember.iterate()) {
      if (group?.groupKey !== row.group_key) {
        group = { groupKey: row.group_key, sessionKeys: [] };
        groups.push(group);
      }
      group.sessionKeys.push(row.session_key);
    }
    return groups;
  }

  #read(afterId: number): OutboxRead {
    const entries = this.#entries.all(afterId);
    if (entries.length === 0) {
      return { batch: undefined, floorPosition: this.#floorLog.position() };
    }
    const rows: IndexRow[] = [];
    const removedKeys: number[] = [];
    const removedOwners: RemovedOwner[] = [];
    const memberGroupKeys = new Set<number>();
    const readKeys = new Set<number>();
    let lastOutboxId = afterId;
    let textLength = 0;
    let isBatchEnded = false;
    for (let start = 0; start < entries.length && !isBatchEnded; start += ROWS_READ_AT_ONCE) {
      const keys: number[] = [];
      for (const entry of entries.slice(start, start + ROWS_READ_AT_ONCE)) {
        lastOutboxId = entry.id;
        if (entry.operation === OutboxOperation.Row) {
          if (!readKeys.has(entry.index_key)) {
            readKeys.add(entry.index_key);
            keys.push(entry.index_key);
          }
        } else if (entry.operation === OutboxOperation.Members) {
          memberGroupKeys.add(entry.owner_key);
        } else {
          removedOwners.push({ ownerKey: entry.owner_key, isGroup: entry.kind === "group" });
          isBatchEnded = true;
          break;
        }
      }
      const currentRows = this.#rows.readRows(keys);
      for (const key of keys) {
        const row = currentRows.get(key);
        if (row === undefined) {
          removedKeys.push(key);
        } else {
          rows.push(indexRowOf(row));
          textLength += row.text.length;
        }
      }
      isBatchEnded ||= textLength > INDEX_BATCH_TEXT_LIMIT;
    }
    const groupMembers = [...memberGroupKeys].map((groupKey) => ({
      groupKey,
      sessionKeys: this.#groupMembers.all(groupKey),
    }));
    return {
      batch: { lastOutboxId, rows, removedKeys, removedOwners, groupMembers },
      floorPosition:
        this.#isEntryAfter.get(lastOutboxId) === 1 ? undefined : this.#floorLog.position(),
    };
  }
}

/**
 * Deletes the outbox rows up to `applied.lastOutboxId` through the writer, a bounded number to a
 * write, and with the first write the floor log's entries up to `applied.keptFloorPosition`.
 * Rejects with what a write threw; the rows it left are deleted with the next applied batch's.
 */
export async function deleteAppliedOutbox(
  writer: Pick<DatabaseWriter, "write">,
  applied: AppliedOutbox,
): Promise<void> {
  const deleteApplied = { sql: APPLIED_ROWS_DELETE_SQL, bindings: [applied.lastOutboxId] };
  let [deleted] = await writer.write([
    deleteApplied,
    floorsLetGoStatement(applied.keptFloorPosition),
  ]);
  while ((deleted?.rowCount ?? 0) === APPLIED_ROWS_PER_DELETE) {
    [deleted] = await writer.write([deleteApplied]);
  }
}
