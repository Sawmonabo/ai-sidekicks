// A long table's fingerprint, read from its parsed rows alone.

import type { Table, TableCell, TableRow } from "mdast";

import { workInSlices } from "#renderer/lib/work-slices.js";
import { TextFingerprint } from "../body-blocks.js";

/**
 * Parsed tables' fingerprints, each read once per parsed table: reading one walks every row's text,
 * and a parsed table never changes. One is held per window, for its tables on and off the list. A
 * table's reading under way is shared by everyone who reads it, so its rows are read once.
 */
export class TableFingerprints {
  readonly #byTable = new WeakMap<Table, string>();
  readonly #readings = new WeakMap<Table, TableFingerprintReading>();

  /**
   * A table's fingerprint: its column count and every row's text, so two tables share one only
   * when they draw the same. A streaming table drawn again once its block settles keeps the one it
   * last had, so its geometry carries over.
   */
  public fingerprintOf(table: Table): string {
    const held = this.#byTable.get(table);
    if (held !== undefined) {
      return held;
    }
    const reading = this.#readingOf(table);
    let fingerprint = reading.readRow();
    while (fingerprint === undefined) {
      fingerprint = reading.readRow();
    }
    return fingerprint;
  }

  /** A table's fingerprint once it is read, reading nothing; `undefined` before. */
  public heldFingerprintOf(table: Table): string | undefined {
    return this.#byTable.get(table);
  }

  /**
   * Reads `table`'s fingerprint a row at a time, for work that visits its rows in slices; it is
   * held once the last row is read. `undefined` when it is held already.
   */
  public startReading(table: Table): TableFingerprintReading | undefined {
    return this.#byTable.has(table) ? undefined : this.#readingOf(table);
  }

  /**
   * Reads `table`'s fingerprint in slices of `view`'s thread, each a task of its own. Resolves it,
   * or `undefined` when `isStopped` answers true before a slice.
   */
  public async readInSlices(
    table: Table,
    view: Window,
    isStopped: () => boolean,
  ): Promise<string | undefined> {
    const reading = this.startReading(table);
    if (reading !== undefined) {
      const isRead = await workInSlices(
        view,
        (hasTime) => {
          let fingerprint: string | undefined;
          while (fingerprint === undefined && hasTime()) {
            fingerprint = reading.readRow();
          }
          return fingerprint !== undefined;
        },
        isStopped,
      );
      if (!isRead) {
        return undefined;
      }
    }
    return this.#byTable.get(table);
  }

  #readingOf(table: Table): TableFingerprintReading {
    const underWay = this.#readings.get(table);
    if (underWay !== undefined) {
      return underWay;
    }
    const reading = new TableFingerprintReading(table, (fingerprint) => {
      this.#byTable.set(table, fingerprint);
      this.#readings.delete(table);
    });
    this.#readings.set(table, reading);
    return reading;
  }
}

/** One table's fingerprint, read a row at a time from its head row on. */
export class TableFingerprintReading {
  readonly #table: Table;
  readonly #onRead: (fingerprint: string) => void;
  readonly #text = new TextFingerprint();
  #nextIndex = 0;
  #fingerprint: string | undefined;

  /** `onRead` is given the fingerprint once the last row is read. */
  public constructor(table: Table, onRead: (fingerprint: string) => void) {
    this.#table = table;
    this.#onRead = onRead;
  }

  /**
   * Reads the table's next row; answers the fingerprint once the last row is read, and reads
   * nothing more after that.
   */
  public readRow(): string | undefined {
    if (this.#fingerprint !== undefined) {
      return this.#fingerprint;
    }
    const rows = this.#table.children;
    const row = rows[this.#nextIndex];
    // The column count leads the text, read with the head row.
    const lead =
      this.#nextIndex === 0
        ? `${String(rows[0]?.children.length ?? 0)}${ROW_SEPARATOR}`
        : ROW_SEPARATOR;
    if (row !== undefined) {
      this.#text.read(`${lead}${rowSignatureOf(row)}`);
      this.#nextIndex += 1;
    } else if (this.#nextIndex === 0) {
      this.#text.read(lead);
    }
    if (this.#nextIndex < rows.length) {
      return undefined;
    }
    const fingerprint = this.#text.value;
    this.#fingerprint = fingerprint;
    this.#onRead(fingerprint);
    return fingerprint;
  }
}

/** What marks inline kinds and joins cells and rows in a fingerprint: no parsed cell holds them. */
const INLINE_KIND_SEPARATOR = "\u0002";
const CELL_SEPARATOR = "\u0000";
const ROW_SEPARATOR = "\u0001";

function rowSignatureOf(row: TableRow): string {
  return row.children.map(cellSignatureOf).join(CELL_SEPARATOR);
}

/** A cell as drawn: each inline node's kind, with its text, code, markup or an image's alt. */
function cellSignatureOf(cell: TableCell): string {
  let text = "";
  const visit = (node: { readonly type: string }): void => {
    text += `${node.type}${INLINE_KIND_SEPARATOR}`;
    if ("value" in node && typeof node.value === "string") {
      text += node.value;
    } else if ("alt" in node && typeof node.alt === "string") {
      text += node.alt;
    }
    if ("children" in node && Array.isArray(node.children)) {
      for (const child of node.children as readonly { readonly type: string }[]) {
        visit(child);
      }
    }
  };
  visit(cell);
  return text;
}
