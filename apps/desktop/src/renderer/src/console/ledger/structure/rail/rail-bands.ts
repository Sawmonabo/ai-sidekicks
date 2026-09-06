// THE ROW-BAND MODEL — the rail's one geometry, stated here and derived nowhere else.
//
// Its own module because it has two consumers on opposite sides of a seam: the rail's
// derivation places a mark with it, and the component that draws the thumb is handed
// a band by a caller it cannot vouch for and clamps it with the same function. Two
// derivations of "where on the rail" is how a mark ends up outside the thumb that is
// supposed to be pointing at it, so there is one.

import { RAIL_THUMB_MIN_EXTENT } from "../structure-bounds.js";

/**
 * THE ROW-BAND MODEL — the rail's one geometry, stated here and derived nowhere
 * else.
 *
 * The retained viewport rows partition the rail into `n` equal BANDS, one per row,
 * in the order the feed renders them. Two readings come out of that partition and
 * they are the same measurement:
 *
 *   • A row's mark sits at the CENTRE of its band, `(rowIndex + 0.5) / n`.
 *   • The viewport's thumb SPANS the bands of the rows the box intersects, from
 *     `firstRowIndex / n` for `(lastRowIndex - firstRowIndex + 1) / n`.
 *
 * Which makes "a visible row's mark lies inside the thumb" arithmetic rather than
 * coincidence — `firstRowIndex ≤ i ≤ lastRowIndex` gives
 * `firstRowIndex / n ≤ (i + 0.5) / n < (lastRowIndex + 1) / n` — and it makes the
 * thumb end exactly at the rail's bottom, because the last row's band does.
 *
 * BOTH HALVES WERE ONCE DERIVED SEPARATELY AND NEITHER WAS SAFE. Marks were placed
 * by SEQUENCE distance, which is a different axis: filtering, sequence gaps, and
 * the synthetic chapter-header rows the feed inserts all make row order and
 * sequence order diverge, so a mark placed on one axis and a thumb placed on the
 * other could not be compared. And the thumb's top was taken against the last
 * INDEX while its height was taken against the row COUNT, which are two
 * denominators: at the tail of a hundred rows that reads 90.9% down with 10% of
 * height, and the thumb hung off the end of the rail.
 */
export interface RailViewportBand {
  /** The band's top, 0 at the rail's head and 1 at its foot. */
  readonly position: number;
  /** How much of the rail the band covers, as a fraction. */
  readonly extent: number;
}

/** Where the mark for the row at `rowIndex` sits, in a window of `retainedRowCount`. */
export function railRowBandCentre(rowIndex: number, retainedRowCount: number): number {
  // A rail with no bands has no centre to give. Unreachable from the derivation,
  // which places a mark only for a row it found an index for, and answered rather
  // than divided by zero because the two callers of a geometry are what this
  // module exists to keep in step.
  return retainedRowCount === 0 ? 0 : (rowIndex + 0.5) / retainedRowCount;
}

/**
 * The band the rows `firstRowIndex` through `lastRowIndex` occupy.
 *
 * An unmeasured or empty window is the WHOLE rail rather than a band at its head:
 * a thumb covering everything says "this is all of it", which is the honest answer
 * for a box nothing has measured, and a thumb at the head would say the reader is
 * at the top of a window nobody has read.
 */
export function railViewportBand(
  firstRowIndex: number,
  lastRowIndex: number,
  retainedRowCount: number,
): RailViewportBand {
  if (retainedRowCount === 0) {
    return { position: 0, extent: 1 };
  }
  return clampRailViewportBand({
    position: firstRowIndex / retainedRowCount,
    extent: (lastRowIndex - firstRowIndex + 1) / retainedRowCount,
  });
}

/**
 * Bring an arbitrary band inside the rail, in ONE act.
 *
 * The extent settles first and the top is then clamped against `1 - extent`,
 * because those two numbers are not independent: clamping each into `[0, 1]` on
 * its own admits `0.909 + 0.1`, which is a thumb hanging over the rail's foot. The
 * order also means the minimum height is paid for out of the TOP rather than out
 * of the rail — a one-row thumb at the very bottom is nudged up to fit rather than
 * grown past the end.
 *
 * Exported because the component that draws the thumb is handed a band by its
 * caller and cannot assume the caller built it here; one clamp, in one module, is
 * what keeps the two sides of that seam from clamping differently.
 */
export function clampRailViewportBand(band: RailViewportBand): RailViewportBand {
  const extent = Math.min(1, Math.max(RAIL_THUMB_MIN_EXTENT, band.extent));
  return { position: Math.min(1 - extent, Math.max(0, band.position)), extent };
}
