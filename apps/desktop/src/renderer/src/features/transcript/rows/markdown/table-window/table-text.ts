// A long table's fingerprint, read from its parsed rows alone.

import type { Table, TableCell, TableRow } from "mdast";

import { fingerprintOf } from "../body-blocks.js";

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
    const fingerprint = tableFingerprintOf(table);
    this.#byTable.set(table, fingerprint);
    return fingerprint;
  }
}

/** What marks inline kinds and joins cells and rows in a fingerprint: no parsed cell holds them. */
const INLINE_KIND_SEPARATOR = "\u0002";
const CELL_SEPARATOR = "\u0000";
const ROW_SEPARATOR = "\u0001";

function tableFingerprintOf(table: Table): string {
  const text = table.children.map(rowSignatureOf).join(ROW_SEPARATOR);
  return fingerprintOf(`${String(table.children[0]?.children.length ?? 0)}${ROW_SEPARATOR}${text}`);
}

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
