// One way to write a process table by hand, for the suites that have to: the reader's walk
// cases, the identity check's stamp comparisons and the termination matrix's scripted platform.
// They want rows in the shape `readProcessTable` produces, and three constructors would drift
// when `ProcessTableRow` grows a column.
//
// It builds the table's data and decides nothing, so no suite checks its own copy of a rule by
// using it. The real parser is driven with real text in `process-tree-readers.test.ts`.

import { type ProcessTableRow } from "./process-tree/readers.js";

/**
 * A process table out of `[pid, parent pid, start stamp?]` rows. The stamp is optional because a
 * walk reads only the parent column, and a placeholder would invite a case to assert on a value
 * nothing meant.
 */
export function processTableOf(
  rows: readonly (readonly [number, number, (string | undefined)?])[],
): ReadonlyMap<number, ProcessTableRow> {
  return new Map(
    rows.map(([childProcessId, parentProcessId, startStamp]) => [
      childProcessId,
      { parentProcessId, startStamp },
    ]),
  );
}
