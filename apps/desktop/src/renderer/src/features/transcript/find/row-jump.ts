// Sending the reader to one row: find it in the loaded window, and name which narrowing
// between the loaded log and the viewport keeps it out of view.

import type { TimelineRow } from "@ai-sidekicks/contracts";

/**
 * Narrow one loaded window on a row predicate, boundary rule included: a narrowing still
 * admits the `rollback_boundary` rows of every run whose rows it admits, because a
 * boundary is what marks the rows around it superseded.
 *
 * Two passes, and the second is that rule: the first admits rows on their own
 * merits and records which runs were admitted, and the second re-admits every
 * `rollback_boundary` belonging to one of those runs. A single pass could not do
 * it — a boundary earlier in the window than any admitted row of its run would
 * have to be judged before the run was known.
 *
 * Order is preserved throughout: this narrows, it never sorts.
 */
export function narrowLedgerRows(
  rows: readonly TimelineRow[],
  admits: (row: TimelineRow) => boolean,
): readonly TimelineRow[] {
  const admittedRowIds = new Set<string>();
  const admittedRunIds = new Set<string>();

  for (const row of rows) {
    if (!admits(row)) {
      continue;
    }
    admittedRowIds.add(row.id);
    if (row.kind !== "general") {
      admittedRunIds.add(row.runId);
    }
  }

  for (const row of rows) {
    if (row.kind === "rollback_boundary" && admittedRunIds.has(row.runId)) {
      admittedRowIds.add(row.id);
    }
  }

  return rows.filter((row) => admittedRowIds.has(row.id));
}

/**
 * The narrowings a row passes through between the loaded log and the viewport, in
 * the order the feed applies them.
 *
 * DECLARED AS A TUPLE BECAUSE THE ORDER IS THE VALUE. A row absent from the
 * viewport is absent for exactly one reason — the FIRST stage that did not admit
 * it — and the stages are strictly nested, so any other order would report a later
 * cause for an earlier one. The set the classifier walks and the set a renderer
 * must have words for are therefore the same set, derived from this line rather
 * than restated beside it.
 */
export const LEDGER_JUMP_ABSENCES = ["folded-into-chapter", "outside-window"] as const;

/** Which narrowing took a row out of the viewport. */
export type LedgerJumpAbsence = (typeof LEDGER_JUMP_ABSENCES)[number];

/**
 * What one stage kept, asked by row id.
 *
 * An interface rather than `ReadonlySet<string>` so a caller passes whichever
 * lookup it already holds — the projection's `rowsByKey` map, the viewport's key
 * set — instead of copying one into the other shape on every keystroke.
 */
export interface LedgerRowIdMembership {
  readonly has: (rowId: string) => boolean;
}

/**
 * What each stage admitted, for one classification.
 *
 * Total over the absence tuple by construction: a narrowing added to
 * `LEDGER_JUMP_ABSENCES` fails to compile at every caller until that caller says
 * what the new stage kept, which is the whole reason the stages arrive as a record
 * rather than as an array a caller could pass short or out of order.
 */
export type LedgerJumpStages = Readonly<Record<LedgerJumpAbsence, LedgerRowIdMembership>>;

/**
 * Where a jump lands, or why it did not.
 *
 * A discriminated result rather than `TimelineRow | undefined`, because each failure
 * calls for different words and a different act: a folded row is reached by opening its
 * run group, and a row the cap took by nothing this build can press.
 *
 * `not-in-loaded-log` is the one absence that is not a stage of the pipeline: no
 * narrowing dropped the row, because this window never held it.
 */
export type LedgerJumpOutcome =
  | { readonly status: "found"; readonly row: TimelineRow }
  | { readonly status: LedgerJumpAbsence; readonly row: TimelineRow }
  | { readonly status: "not-in-loaded-log" };

/**
 * Find a row by id, and which narrowing keeps it out of the viewport.
 *
 * Takes the loaded rows and what every stage between them and the viewport kept,
 * which is the only reason it takes more than one window: the answer is not
 * whether the row is on screen but WHICH narrowing is the reason it is not, and
 * that is a question about the stages rather than about either end of them.
 */
export function jumpToEventId(
  loadedRows: readonly TimelineRow[],
  stages: LedgerJumpStages,
  eventId: string,
): LedgerJumpOutcome {
  const row = loadedRows.find((candidate) => candidate.id === eventId);
  if (row === undefined) {
    return { status: "not-in-loaded-log" };
  }
  for (const absence of LEDGER_JUMP_ABSENCES) {
    if (!stages[absence].has(eventId)) {
      return { status: absence, row };
    }
  }
  return { status: "found", row };
}
