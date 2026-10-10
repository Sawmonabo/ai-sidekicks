// What the row measurement table estimates an unmeasured row of the feed's list by: the height
// kind it draws as and the length of its body. Read for the list the feed holds, and for a page
// of history the feed has not drawn yet.

import {
  CONTENT_LENGTH_PAYLOAD_KEY,
  CONTENT_PAYLOAD_PLAINTEXT_MAX,
  CONTENT_TRUNCATED_PAYLOAD_KEY,
} from "@ai-sidekicks/contracts/event/declared-variants";

import { projectedPayload, readWireCount } from "#renderer/store/session/events/wire-payload.js";
import { type RowHeightKind } from "../rows/height-kind.js";
import { classifyTranscriptRow, isFoldableCall } from "../rows/kind.js";
import { type TranscriptWindowModel } from "../window/transcript-window.js";
import { densityFor } from "./fold-state.js";

/**
 * The height kind the feed draws a key of its list as, decided as the row dispatch and the tool
 * card decide what to draw: a call draws its body only where it has one and nobody folded it.
 * `isRevealing` names a row whose output is streaming in, which has a body before it has a count.
 */
export function rowHeightKindOf(
  transcriptWindow: TranscriptWindowModel,
  foldedCallRowIds: ReadonlySet<string>,
  isRevealing: (rowId: string) => boolean,
  rowKey: string,
): RowHeightKind {
  if (transcriptWindow.runGroupByHeaderKey.has(rowKey)) {
    return "run-group-header";
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
  return isFoldableCall(row, isRevealing(row.id)) &&
    densityFor(row.id, foldedCallRowIds) === "expanded"
    ? "tool-call-expanded"
    : "tool-call-collapsed";
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
