// The run group of the loaded window holding a row: the pure half of sending the reader to one
// row.

import { type TimelineRow } from "@ai-sidekicks/contracts";

import { readRunIdOfGroupedRow } from "../run-groups/run-groups.js";
import { type TranscriptWindowModel } from "../window/transcript-window.js";

/**
 * Which run group of this window holds a row, if one does.
 *
 * Composes `readRunIdOfGroupedRow` so which rows carry a run stays one rule.
 */
export function findRunGroupRunIdInWindow(
  row: TimelineRow,
  foldedWindow: TranscriptWindowModel,
): string | undefined {
  const runId = readRunIdOfGroupedRow(row);
  if (runId === undefined) {
    return undefined;
  }
  return foldedWindow.runGroupByHeaderKey.has(runId) ? runId : undefined;
}
