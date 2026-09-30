// The row a jump names, and the run group of the loaded window holding it: the pure half
// of sending the reader to one row.

import { type TimelineRow } from "@ai-sidekicks/contracts";

import { readRunIdOfGroupedRow } from "../run-groups/run-groups.js";
import { type TranscriptWindowModel } from "../window/transcript-window.js";
import { type RowJumpOutcome } from "./row-jump.js";

/**
 * The row the transcript's current question names, or `undefined` where it names none.
 *
 * The one reading shared by the feed and the deferred jump, which abandons its request when
 * this changes.
 */
export function jumpOutcomeRowId(outcome: RowJumpOutcome | undefined): string | undefined {
  return outcome === undefined || outcome.status === "not-in-loaded-log"
    ? undefined
    : outcome.row.id;
}

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
