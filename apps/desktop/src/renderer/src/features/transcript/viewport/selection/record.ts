// The reader's selection as a viewport records it, the record copy reads and the tracker keeps:
// each end a row key and a position in that row's text, or an end of the conversation, in log
// order. An end of the conversation covers every row on its side, those the log holds and those
// still to be read, so a selection past the loaded rows keeps reaching as more of them land.

import type { RowTextPosition } from "./preservation.js";

/**
 * One end of the reader's selection: a place in the row it sits in, or the conversation's first
 * or last event, which an end outside the scroller or Select All takes.
 */
export type RowSelectionBoundary =
  | {
      readonly at: "row";
      readonly rowKey: string;
      /**
       * Where the end sits in the row's text, as `preservation.ts` keeps it; `undefined` when it
       * could not be placed in it, which takes the row whole.
       */
      readonly position: RowTextPosition | undefined;
    }
  | { readonly at: "conversation-start" }
  | { readonly at: "conversation-end" };

/** The end before every row of the conversation. */
export const CONVERSATION_START: RowSelectionBoundary = { at: "conversation-start" };

/** The end after every row of the conversation, the newest the stream delivers included. */
export const CONVERSATION_END: RowSelectionBoundary = { at: "conversation-end" };

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

/** The key of the row `boundary` sits in, or `undefined` for an end of the conversation. */
export function rowKeyOf(boundary: RowSelectionBoundary): string | undefined {
  return boundary.at === "row" ? boundary.rowKey : undefined;
}

/**
 * Where `boundary` stands in the log: its row's position as `logPositionOf` reads it, or past
 * every row on its side for an end of the conversation; `undefined` for a row the log lacks.
 */
export function logOrderOf(
  boundary: RowSelectionBoundary,
  logPositionOf: (rowKey: string) => number | undefined,
): number | undefined {
  switch (boundary.at) {
    case "row":
      return logPositionOf(boundary.rowKey);
    case "conversation-start":
      return Number.NEGATIVE_INFINITY;
    case "conversation-end":
      return Number.POSITIVE_INFINITY;
  }
}
