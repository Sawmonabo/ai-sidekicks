// Long-table geometry remembered across mounts, beside the blocks' own memory: the column widths a
// table was held at, its rows' type and every row height it measured, at one body type. A table
// drawn again, its row scrolled back in or its streaming block settled into place, takes the same
// columns and lays its undrawn rows out at the heights they last measured, so a fling back up does
// not jump and no column moves. A settled block's table is filed by a key read without walking its
// rows, its block's fingerprint, the definitions it is parsed after and its place in the block, and
// the body's width and text size. A streaming table has no such key: its window hands its geometry
// to the next mount of its row's table that starts at the same place in the body's text.

import type { Table } from "mdast";

import { ByteBoundedCache } from "#renderer/lib/byte-bounded-cache.js";
import { type HeldTableColumns } from "#renderer/components/Markdown/table-offer.js";
import { fingerprintOf } from "../body-blocks.js";
import { bodyTypeKeyOf, type MarkdownBodyType } from "../body-type.js";
import { type TableCellType } from "./cell-measure.js";

/** What one table's memory holds. */
export interface TableGeometry {
  readonly columns: HeldTableColumns;
  /** How its cells set their text and their box, which an undrawn row's estimate reads. */
  readonly cellType: TableCellType;
  /** Each body row's measured height in CSS pixels, by index; `0` for a row never measured. */
  readonly rowHeightsPx: Float32Array;
  /** The body rows the columns were measured from, which hold each column's widest cells. */
  readonly sampleRowIndexes: readonly number[];
}

/** Where one table's geometry is filed. */
export interface TableGeometryAddress {
  /** The table's key, from `settledTableKeyOf`. */
  readonly tableKey: string;
  /** The body's width and text size: rows wrap differently at another. */
  readonly bodyType: MarkdownBodyType;
}

/**
 * A streaming table's geometry as its last mount held it, handed to its next mount, which draws it
 * while the table is measured anew: rows may have arrived, and fonts loaded, since.
 */
export interface HandedTableGeometry {
  readonly geometry: TableGeometry;
  /** The body type the geometry was measured at. */
  readonly bodyType: MarkdownBodyType;
}

/**
 * One window's streaming tables' geometry, each held by its row and where it starts in the row's
 * body text, for the mount that draws that table next: the same table remounted as the blocks
 * ahead of it settle, its row listed again after it left the list, or its own block settled. An
 * entry lives until that mount takes it or the log lets its row go, so the window holds at most
 * the last handed geometry of each streaming table in the log.
 */
export class StreamingTableGeometries {
  readonly #byRow = new Map<string, Map<number, HandedTableGeometry>>();

  /**
   * Hands the geometry of row `rowKey`'s table starting at `startInBody`, in UTF-16 code units of
   * the body's text, to its next mount, in place of what was handed there before.
   */
  public hand(rowKey: string, startInBody: number, handed: HandedTableGeometry): void {
    const row = this.#byRow.get(rowKey);
    if (row === undefined) {
      this.#byRow.set(rowKey, new Map([[startInBody, handed]]));
    } else {
      row.set(startInBody, handed);
    }
  }

  /** Takes what was handed to the table starting there, which no later mount takes again. */
  public take(rowKey: string, startInBody: number): HandedTableGeometry | undefined {
    const row = this.#byRow.get(rowKey);
    const handed = row?.get(startInBody);
    row?.delete(startInBody);
    if (row?.size === 0) {
      this.#byRow.delete(rowKey);
    }
    return handed;
  }

  /** Lets go of what was handed to the tables of every row `rowsByKey` no longer holds. */
  public retainRows(rowsByKey: ReadonlyMap<string, unknown>): void {
    for (const rowKey of this.#byRow.keys()) {
      if (!rowsByKey.has(rowKey)) {
        this.#byRow.delete(rowKey);
      }
    }
  }
}

/**
 * Bytes of remembered table geometry across every body: one MiB, 262,144 row heights at four
 * bytes each, the rows of about 85 tables of 3,078 rows. Past it the table used longest ago is
 * dropped whole: drawn again, it measures its columns anew and its rows stand at estimates until
 * each is measured.
 */
const TABLE_GEOMETRY_MEMORY_BYTE_CAP = 1_048_576;

/** What one entry holds on the heap beyond its typed array and key: the record and its columns. */
const TABLE_GEOMETRY_ENTRY_OVERHEAD_BYTES = 250;

/** The bytes one held column width or sample row index takes, a double in its array. */
const NUMBER_BYTES = 8;

const tableGeometryMemory: ByteBoundedCache<TableGeometry> = new ByteBoundedCache<TableGeometry>(
  TABLE_GEOMETRY_MEMORY_BYTE_CAP,
  (geometry) =>
    geometry.rowHeightsPx.byteLength +
    (geometry.columns.widthsPx.length + geometry.sampleRowIndexes.length) * NUMBER_BYTES +
    TABLE_GEOMETRY_ENTRY_OVERHEAD_BYTES,
);

/**
 * The key a settled block's long table is filed under, read without walking its rows: the block's
 * fingerprint, the fingerprint of the definitions it is parsed after, and the table's place in it.
 */
export function settledTableKeyOf(
  blockFingerprint: string,
  definitionPreamble: string,
  table: Table,
): string {
  // Where the table starts in its block's text: its parsed offset less the definitions.
  const placeInBlock = (table.position?.start.offset ?? 0) - definitionPreamble.length;
  return `${blockFingerprint}/${fingerprintOf(definitionPreamble)}/${String(placeInBlock)}`;
}

/** The geometry last kept for the table at this address, or `undefined`. */
export function recallTableGeometry(address: TableGeometryAddress): TableGeometry | undefined {
  return tableGeometryMemory.get(memoryKeyOf(address));
}

/**
 * Files a table's geometry, the oldest giving way once the cap is reached. The row heights are the
 * array the table keeps measuring into, so a row measured later is remembered with no second
 * filing; a table that outgrows its array files the larger one.
 */
export function rememberTableGeometry(
  address: TableGeometryAddress,
  geometry: TableGeometry,
): void {
  tableGeometryMemory.set(memoryKeyOf(address), geometry);
}

/**
 * Forgets every table's geometry: a font that finished loading sets text at other widths, so no
 * column measured before it holds.
 */
export function forgetTableGeometries(): void {
  tableGeometryMemory.clear();
}

function memoryKeyOf(address: TableGeometryAddress): string {
  return `${address.tableKey}@${bodyTypeKeyOf(address.bodyType)}`;
}
