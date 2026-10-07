// Which rows a held search's ranking still names. A source table gives a new row the rowid after
// its highest, so once a delete lowers a table's highest rowid, a later row can take a rowid a held
// ranking holds and the index row there indexes another row. Every such delete logs the table's
// new highest rowid. A held row is still the row its ranking read while its source rowid is no
// higher than every highest rowid logged since the ranking, since no later row can have taken it;
// one higher was deleted after the ranking, whatever sits at its rowid now. This holds while the
// source tables insert without naming a rowid and never `REPLACE`, whose deletes fire no trigger.

import type { Database, Statement } from "better-sqlite3";

import { indexRowKindOf, sourceRowidOf, type IndexRowKind } from "./index-columns.js";

// The log keeps its newest entries; a search held from before the oldest one is let go.
const KEPT_FLOOR_COUNT = 4096;

/** The SQL of the trigger that logs `table`'s highest rowid when a delete lowers it. */
export function rowidFloorTriggerSql(table: string, kind: IndexRowKind): string {
  const highestRowid = `coalesce((SELECT max(rowid) FROM ${table}), 0)`;
  return `
CREATE TRIGGER trg_session_search_${kind}_floor AFTER DELETE ON ${table}
WHEN OLD.rowid > ${highestRowid}
BEGIN
  INSERT INTO session_search_rowid_floors (kind, highest_rowid)
  VALUES ('${kind}', ${highestRowid});
  DELETE FROM session_search_rowid_floors
   WHERE id <= (SELECT max(id) FROM session_search_rowid_floors) - ${String(KEPT_FLOOR_COUNT)};
END;`;
}

/** Whether the index row at this rowid still indexes the source row a held ranking read. */
export type HeldRowCheck = (indexRowid: number) => boolean;

interface FloorRow {
  readonly kind: IndexRowKind;
  readonly highest_rowid: number;
}

/** Reads the log of lowered highest rowids on the daemon's read connection. */
export class RowidFloorLog {
  readonly #newestEntry: Statement<[], { readonly id: number | null }>;
  readonly #oldestEntry: Statement<[], { readonly id: number | null }>;
  readonly #floorsSince: Statement<[number], FloorRow>;

  constructor(reader: Database) {
    this.#newestEntry = reader.prepare("SELECT max(id) AS id FROM session_search_rowid_floors");
    this.#oldestEntry = reader.prepare("SELECT min(id) AS id FROM session_search_rowid_floors");
    this.#floorsSince = reader.prepare(
      `SELECT kind, min(highest_rowid) AS highest_rowid FROM session_search_rowid_floors
        WHERE id > ? GROUP BY kind`,
    );
  }

  /** Where the log stands, read in the transaction a ranking is read in to hold it from there. */
  position(): number {
    return this.#newestEntry.get()?.id ?? 0;
  }

  /**
   * The check of the rows a ranking held from `position` holds; `undefined` once the log has let go
   * of an entry written since, when which rows a later row took can no longer be told.
   */
  heldRowCheck(position: number): HeldRowCheck | undefined {
    const oldest = this.#oldestEntry.get()?.id ?? null;
    if (oldest !== null && oldest > position + 1) {
      return undefined;
    }
    const floors = new Map<IndexRowKind, number>();
    for (const row of this.#floorsSince.all(position)) {
      floors.set(row.kind, row.highest_rowid);
    }
    return (indexRowid) => {
      const floor = floors.get(indexRowKindOf(indexRowid));
      return floor === undefined || sourceRowidOf(indexRowid) <= floor;
    };
  }
}
