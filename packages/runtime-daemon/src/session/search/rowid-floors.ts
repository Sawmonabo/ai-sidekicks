// Which index rows a held search's view still names. A source table gives a new row the rowid after
// its highest, so once a delete lowers a table's highest rowid, a later row can take a rowid a held
// view indexed, and reading that key from the database would read another row. Every such delete
// logs the table's new highest rowid. A row the view indexed is still that row while its source
// rowid is no higher than every highest rowid logged since the view's database state; one higher
// was deleted since, whatever sits at its rowid now. This holds while the source tables insert
// without naming a rowid and never `REPLACE`, whose deletes fire no trigger. The search thread lets
// go of the entries no held search and no newer view needs, through the database writer.

import type { Database, Statement } from "better-sqlite3";

import type { IndexRowKind } from "@ai-sidekicks/search-index";

import type { WriteStatement } from "../../database/statement.js";
import { indexRowKindOf, sourceRowidOf } from "./index/columns.js";

/** The SQL of the trigger that logs `table`'s highest rowid when a delete lowers it. */
export function rowidFloorTriggerSql(table: string, kind: IndexRowKind): string {
  const highestRowid = `coalesce((SELECT max(rowid) FROM ${table}), 0)`;
  return `
CREATE TRIGGER trg_session_search_${kind}_floor AFTER DELETE ON ${table}
WHEN OLD.rowid > ${highestRowid}
BEGIN
  INSERT INTO session_search_rowid_floors (kind, highest_rowid)
  VALUES ('${kind}', ${highestRowid});
END;`;
}

/** Lets go of the log's entries up to `position`, which no held search reads past any more. */
export function floorsLetGoStatement(position: number): WriteStatement {
  return { sql: "DELETE FROM session_search_rowid_floors WHERE id <= ?", bindings: [position] };
}

/** Whether the index row with this key still names the source row a held view indexed. */
export type HeldRowCheck = (key: number) => boolean;

interface FloorRow {
  readonly kind: IndexRowKind;
  readonly highest_rowid: number;
}

/** Reads the log of lowered highest rowids on one connection. */
export class RowidFloorLog {
  readonly #newestEntry: Statement<[], number | null>;
  readonly #floorsSince: Statement<[number], FloorRow>;

  constructor(reader: Database) {
    this.#newestEntry = reader
      .prepare<[], number | null>("SELECT max(id) FROM session_search_rowid_floors")
      .pluck();
    this.#floorsSince = reader.prepare(
      `SELECT kind, min(highest_rowid) AS highest_rowid FROM session_search_rowid_floors
        WHERE id > ? GROUP BY kind`,
    );
  }

  /** Where the log stands in the connection's current read. */
  position(): number {
    return this.#newestEntry.get() ?? 0;
  }

  /** The check of the rows a view of the database at `position` indexed. */
  heldRowCheck(position: number): HeldRowCheck {
    const floors = new Map<IndexRowKind, number>();
    for (const row of this.#floorsSince.all(position)) {
      floors.set(row.kind, row.highest_rowid);
    }
    return (key) => {
      const floor = floors.get(indexRowKindOf(key));
      return floor === undefined || sourceRowidOf(key) <= floor;
    };
  }
}
