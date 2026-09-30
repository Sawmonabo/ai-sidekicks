// The termination matrix as one table, composed from the cells beside each arm
// (`termination-matrix-external.test-support.ts` and `termination-matrix-signal.test-support.ts`).
// Findings against this path (a refused `taskkill` read as a kill, an unreaped zombie read as live,
// a stale parent row under an unheld pid) were each one cell of the same table; a suite organized
// by finding would miss a fix that closes one cell and reopens another. The two arms cannot run on
// each other's platform, so this module is the one place that says the table is their union.

import { type TerminationCell } from "./termination-matrix-axes.test-support.js";
import { EXTERNAL_TERMINATION_CELLS } from "./termination-matrix-external.test-support.js";
import { SIGNALED_AND_OBSERVED_CELLS } from "./termination-matrix-signal.test-support.js";

/** Every state the termination path can be asked in, with the verdict each owes. */
export const TERMINATION_MATRIX: readonly TerminationCell[] = [
  ...EXTERNAL_TERMINATION_CELLS,
  ...SIGNALED_AND_OBSERVED_CELLS,
];
