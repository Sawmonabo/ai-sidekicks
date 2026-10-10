// What the row measurement table estimates an unmeasured row of the feed's list by: the height
// kind it draws as and the length of its body. Read for the list the feed holds, for a page of
// history the feed has not drawn yet, and for the calls a long run's window is cut in.

import {
  CONTENT_LENGTH_PAYLOAD_KEY,
  CONTENT_PAYLOAD_PLAINTEXT_MAX,
  CONTENT_TRUNCATED_PAYLOAD_KEY,
} from "@ai-sidekicks/contracts/event/declared-variants";

import { projectedPayload, readWireCount } from "#renderer/store/session/events/wire-payload.js";
import { readRunWindowEdgeKey, type RunWindowMeasure } from "../runs/call-window.js";
import { type RowHeightKind } from "../rows/height-kind.js";
import { classifyTranscriptRow, isFoldableCall } from "../rows/kind.js";
import { type TranscriptViewportBinding } from "../viewport/hooks/useTranscriptViewport.js";
import { type TranscriptWindowModel } from "../window/transcript-window.js";
import { densityFor } from "./fold-state.js";

/** How the feed draws a row of its list, beyond the row itself. */
export interface RowDrawing {
  /** The calls the reader folded; every other call with a body draws open. */
  readonly foldedCallRowIds: ReadonlySet<string>;
  /** The calls whose output the reader opened whole; every other open call's output draws cut. */
  readonly openedOutputRowIds: ReadonlySet<string>;
  /** Whether a row's output is still streaming in. */
  readonly isRevealing: (rowId: string) => boolean;
}

/** What a row's height is estimated from: the viewport's table, and how the feed draws the row. */
export interface RowHeightEstimates extends RowDrawing {
  readonly estimatedRowHeightPx: TranscriptViewportBinding["estimatedRowHeightPx"];
}

/** The estimates a long run's window is cut in, with the screen it is measured against. */
export interface RunWindowEstimates extends RowHeightEstimates {
  /** The viewport's height in pixels. */
  readonly screenHeightPx: () => number;
}

/**
 * The height kind the feed draws a key of its list as, decided as the row dispatch and the tool
 * card decide what to draw: a call draws its body only where it has one and nobody folded it, and
 * the body's output whole once the reader opened it. A row `isRevealing` names has a body before
 * it has a count.
 */
export function rowHeightKindOf(
  transcriptWindow: TranscriptWindowModel,
  drawing: RowDrawing,
  rowKey: string,
): RowHeightKind {
  if (transcriptWindow.runGroupByHeaderKey.has(rowKey)) {
    return "run-group-header";
  }
  if (readRunWindowEdgeKey(rowKey, transcriptWindow.runGroupByHeaderKey) !== undefined) {
    return "run-window-edge";
  }
  const row = transcriptWindow.rowsByKey.get(rowKey);
  if (row === undefined) {
    return "not-loaded";
  }
  if (transcriptWindow.systemMessageByRowId.has(row.id)) {
    return "system-message";
  }
  const kind = classifyTranscriptRow(row)?.kind;
  if (kind === undefined) {
    // A card the kind table does not name, which the registered renderer draws: one line until
    // it measures, as a tool row is.
    return "tool-call-collapsed";
  }
  if (kind !== "tool-call") {
    return kind;
  }
  if (
    !isFoldableCall(row, drawing.isRevealing(row.id)) ||
    densityFor(row.id, drawing.foldedCallRowIds) === "collapsed"
  ) {
    return "tool-call-collapsed";
  }
  return drawing.openedOutputRowIds.has(row.id) ? "tool-call-output-opened" : "tool-call-expanded";
}

/**
 * The UTF-8 byte length of the body a key of the feed's list draws, or `undefined` for a row that
 * reports none. A row `isRevealing` names reports none: it pairs its whole body's length with
 * the height of the part drawn so far. A truncated body draws only its stored prefix, which the
 * stored ceiling bounds.
 */
export function rowBodyLengthOf(
  transcriptWindow: TranscriptWindowModel,
  isRevealing: (rowId: string) => boolean,
  rowKey: string,
): number | undefined {
  const row = transcriptWindow.rowsByKey.get(rowKey);
  if (row === undefined || isRevealing(row.id)) {
    return undefined;
  }
  const payload = projectedPayload(row);
  const contentLength = readWireCount(payload, CONTENT_LENGTH_PAYLOAD_KEY);
  return contentLength !== undefined && payload[CONTENT_TRUNCATED_PAYLOAD_KEY] === true
    ? Math.min(contentLength, CONTENT_PAYLOAD_PLAINTEXT_MAX)
    : contentLength;
}

/** The height, in pixels, the viewport's table estimates a key of `transcriptWindow` at. */
export function estimatedRowHeightPxOf(
  transcriptWindow: TranscriptWindowModel,
  estimates: RowHeightEstimates,
  rowKey: string,
): number {
  return estimates.estimatedRowHeightPx(
    rowKey,
    rowHeightKindOf(transcriptWindow, estimates, rowKey),
    rowBodyLengthOf(transcriptWindow, estimates.isRevealing, rowKey),
  );
}

/** The measure a long run's window over `transcriptWindow`'s rows is cut in. */
export function runWindowMeasureOf(
  transcriptWindow: TranscriptWindowModel,
  estimates: RunWindowEstimates,
): RunWindowMeasure {
  return {
    screenHeightPx: estimates.screenHeightPx,
    rowHeightPx: (rowId) => estimatedRowHeightPxOf(transcriptWindow, estimates, rowId),
  };
}
