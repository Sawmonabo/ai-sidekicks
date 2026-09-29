// The row a jump names, and the run group of the loaded window holding it: the pure half
// of sending the reader to one row.

import { type TimelineRow } from "@ai-sidekicks/contracts";

import { readRunIdOfGroupedRow } from "../run-groups/run-groups.js";
import { type TranscriptWindowModel } from "../window/transcript-window.js";
import { type RowJumpOutcome } from "./row-jump.js";

/**
 * The row the transcript's current question names, or `undefined` where it names none.
 *
 * One expression of it, read by the feed and by the deferred jump alike: the held
 * request is abandoned when this changes, so a second reading of "which row is
 * being asked about" would be a second answer to the question that cancels it.
 */
export function jumpOutcomeRowId(outcome: RowJumpOutcome | undefined): string | undefined {
  return outcome === undefined || outcome.status === "not-in-loaded-log"
    ? undefined
    : outcome.row.id;
}

/**
 * Which run group of this window holds a row, if one does.
 *
 * Composes `readRunIdOfGroupedRow` rather than restating its narrowing: which rows carry
 * a run at all is the chapters module's rule, and what this adds is the membership
 * test against the window in hand. Two copies of the narrowing would drift silently —
 * the jump would go on landing correctly while the chapters it opened were decided by
 * a different reading of the same row.
 */
export function findRunGroupRunIdInWindow(
  row: TimelineRow,
  foldedWindow: TranscriptWindowModel,
): string | undefined {
  const runId = readRunIdOfGroupedRow(row);
  if (runId === undefined) {
    return undefined;
  }
  return foldedWindow.chapterByHeaderKey.has(runId) ? runId : undefined;
}
