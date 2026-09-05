// The measurement seam: what the ledger has measured, and where the reader is standing.
//
// THE SEAM. Every other directory here DECIDES something — which rows exist, how fast
// their text appears, where the surface is scrolled to — and each of those decisions
// needs a reading first: the viewport box and its overflow, how tall a row turned out to
// be once it rendered, and which row the reader is anchored on while the rest of it
// changes underneath them. Those readings are one job, they are the only thing in this
// family that touches layout, and they are batched together because a reading taken per
// row is a layout thrash the frame budget cannot pay.
//
// WHAT LEAVES. The two ledgers the viewport folds, the anchor it keeps a reader on, and
// the geometry the scroll seam compares samples of. `geometry-sample.ts`' comparison
// helpers stay inside, beside the shape they compare.

export { OverflowMeasurementBatch } from "./overflow-measurement-batch.js";
export { ReadingAnchor, type ReadingAnchorState } from "./reading-anchor.js";
export { RowMeasurementLedger, type RowKeyProjection } from "./row-measurement-ledger.js";
export {
  sameSampledGeometry,
  type LedgerGeometry,
  type LedgerGeometryCause,
} from "./geometry-sample.js";
