// Sends the reader to one row: finds it in the loaded window and names the narrowing that
// keeps it out of view.

import type { TimelineRow } from "@ai-sidekicks/contracts";

/**
 * The narrowings a row passes through between the loaded log and the viewport, in the order
 * the feed applies them.
 *
 * The order is the value: a row is absent for the first stage that did not admit it, and the
 * stages nest, so any other order would report a later cause for an earlier one.
 */
export const ROW_JUMP_ABSENCES = ["folded-into-run-group", "outside-window"] as const;

/** Which narrowing took a row out of the viewport. */
export type RowJumpAbsence = (typeof ROW_JUMP_ABSENCES)[number];

/**
 * What one stage kept, asked by row id.
 *
 * An interface rather than `ReadonlySet<string>` so a caller passes whichever lookup it
 * already holds instead of copying it on every keystroke.
 */
export interface RowIdMembership {
  readonly has: (rowId: string) => boolean;
}

/**
 * What each stage admitted, for one classification.
 *
 * A record over the absence tuple, so a narrowing added to `ROW_JUMP_ABSENCES` fails to
 * compile at every caller until that caller says what the new stage kept.
 */
export type RowJumpStages = Readonly<Record<RowJumpAbsence, RowIdMembership>>;

/**
 * Where a jump lands, or why it did not.
 *
 * Each failure calls for different words and a different act: a folded row is reached by
 * opening its run group, a row the cap took by nothing. `not-in-loaded-log` is the one
 * absence that is not a pipeline stage: this window never held the row.
 */
export type RowJumpOutcome =
  | { readonly status: "found"; readonly row: TimelineRow }
  | { readonly status: RowJumpAbsence; readonly row: TimelineRow }
  | { readonly status: "not-in-loaded-log" };

/**
 * Finds a row by id, and which narrowing keeps it out of the viewport.
 *
 * Takes what every stage kept, not one window, because the answer is which narrowing is the
 * reason the row is not on screen.
 */
export function jumpToEventId(
  loadedRows: readonly TimelineRow[],
  stages: RowJumpStages,
  eventId: string,
): RowJumpOutcome {
  const row = loadedRows.find((candidate) => candidate.id === eventId);
  if (row === undefined) {
    return { status: "not-in-loaded-log" };
  }
  for (const absence of ROW_JUMP_ABSENCES) {
    if (!stages[absence].has(eventId)) {
      return { status: absence, row };
    }
  }
  return { status: "found", row };
}
