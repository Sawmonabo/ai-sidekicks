// One way to write a process table by hand, for every suite that has to.
//
// Three of them do — the reader's own walk cases, the identity check's stamp
// comparisons, and the termination matrix's scripted platform — and each of them
// wants rows in the shape `readProcessTable` produces rather than the shape it
// is convenient to type. Written three times it would be three constructors
// drifting apart the next time `ProcessTableRow` grows a column, and the row
// shape is precisely what those suites are asserting against.
//
// A FIXTURE CONSTRUCTOR AND NOT A STAND-IN. It builds the table's DATA; nothing
// here parses, walks, or verifies anything, so no suite is checking its own copy
// of a rule by using it. The real parser is driven with real text in
// `process-tree-readers.test.ts`, which is where the claim that this shape is the
// shape the platform emits actually lives.

import { type ProcessTableRow } from "./process-tree/readers.js";

/**
 * A process table out of `[pid, parent pid, start stamp?]` rows.
 *
 * The stamp is optional because two of the three consumers never read it: a walk
 * over the table cares only about the parent column, and writing a placeholder
 * there would invite a later case to assert on a value nothing meant.
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
