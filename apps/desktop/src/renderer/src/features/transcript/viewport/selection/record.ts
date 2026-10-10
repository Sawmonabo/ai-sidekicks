// The reader's selection as a viewport records it, the record copy reads and the tracker keeps:
// each end a row key and a position in that row's text, in log order.

import type { RowTextPosition } from "./preservation.js";

/** One end of the reader's selection, in the row it sits in. */
export interface RowSelectionBoundary {
  readonly rowKey: string;
  /**
   * Where the end sits in the row's text, as `preservation.ts` keeps it; `undefined` for an end
   * that lies outside the scroller, which takes the log's edge row whole.
   */
  readonly position: RowTextPosition | undefined;
}

/** The reader's selection as the viewport records it: both ends, in log order. */
export interface RowSelection {
  readonly start: RowSelectionBoundary;
  readonly end: RowSelectionBoundary;
}

/** One end of the record: the earlier in the log or the later. */
export type RecordSide = "start" | "end";

/** Both ends, the earlier first. */
export const RECORD_SIDES: readonly RecordSide[] = ["start", "end"];

/** A place in the document the browser's selection can be written to. */
export interface SelectionPoint {
  readonly node: Node;
  readonly offset: number;
}

/** The record's other end. */
export function otherSide(side: RecordSide): RecordSide {
  return side === "start" ? "end" : "start";
}
