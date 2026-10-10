// A long table's fingerprint, read from its parsed rows alone.

import type { Table, TableCell, TableRow } from "mdast";

import { TextFingerprint } from "../body-blocks.js";

/**
 * Parsed tables' fingerprints, each read once per parsed table: reading one walks every row's text,
 * and a parsed table never changes. One is held per window, for its tables on and off the list.
 */
export class TableFingerprints {
  readonly #byTable = new WeakMap<Table, string>();

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

  /**
   * Reads `table`'s fingerprint a row at a time, for work that visits its rows in slices; it is
   * held once the last row is read. `undefined` when it is held already.
   */
  public startReading(table: Table): TableFingerprintReading | undefined {
    return this.#byTable.has(table) ? undefined : this.#readingOf(table);
  }

  #readingOf(table: Table): TableFingerprintReading {
    return new TableFingerprintReading(table, (fingerprint) => {
      this.#byTable.set(table, fingerprint);
    });
  }
}

/** One table's fingerprint, read a row at a time from its head row on. */
export class TableFingerprintReading {
  readonly #table: Table;
  readonly #onRead: (fingerprint: string) => void;
  readonly #text = new TextFingerprint();
  #nextIndex = 0;

  /** `onRead` is given the fingerprint once the last row is read. */
  public constructor(table: Table, onRead: (fingerprint: string) => void) {
    this.#table = table;
    this.#onRead = onRead;
    this.#text.read(`${String(table.children[0]?.children.length ?? 0)}${ROW_SEPARATOR}`);
  }

  /** Reads the table's next row; answers the fingerprint once the last row is read. */
  public readRow(): string | undefined {
    const row = this.#table.children[this.#nextIndex];
    if (row !== undefined) {
      this.#text.read(
        this.#nextIndex === 0 ? rowSignatureOf(row) : `${ROW_SEPARATOR}${rowSignatureOf(row)}`,
      );
      this.#nextIndex += 1;
    }
    if (this.#nextIndex < this.#table.children.length) {
      return undefined;
    }
    const fingerprint = this.#text.value;
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
