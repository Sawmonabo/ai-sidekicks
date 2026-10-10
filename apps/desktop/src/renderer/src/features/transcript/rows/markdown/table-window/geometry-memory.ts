// Long-table geometry remembered across mounts, beside the blocks' own memory: the column widths a
// table was held at, its rows' type and every row height it measured, at one body type. A table
// drawn again, its row scrolled back in or its streaming block settled into place, takes the same
// columns and lays its undrawn rows out at the heights they last measured, so a fling back up does
// not jump and no column moves. Filed by the table's fingerprint and the body's width and text
// size.

import { ByteBoundedCache } from "#renderer/lib/byte-bounded-cache.js";
import { type HeldTableColumns } from "#renderer/components/Markdown/table-offer.js";
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
  /** The table's fingerprint: its every row's text and inline kinds. */
  readonly fingerprint: string;
  /** The body's width and text size: rows wrap differently at another. */
  readonly bodyType: MarkdownBodyType;
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
  return `${address.fingerprint}@${bodyTypeKeyOf(address.bodyType)}`;
}
