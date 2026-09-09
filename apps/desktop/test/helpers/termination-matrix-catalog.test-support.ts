// The termination matrix, as one table.
//
// WHY AN ENUMERATION RATHER THAN A CASE PER DEFECT. Separate findings against
// this path — a refused `taskkill` read as a kill, an unreaped zombie read as a
// live process, a root that exited while a descendant held its stdio, a
// settle-time registration that threw over a child already running, a root pid
// the operating system had already handed to somebody else, a stale parent row
// under a pid nobody holds — were each one CELL of the same table, and each was
// fixed where it was found. A fix that closes one cell and reopens another is
// invisible to a suite organised by finding. The findings are deliberately not
// counted here: the count moved once per round, and the table is the record that
// cannot go stale silently.
//
// COMPOSED RATHER THAN AUTHORED HERE. The cells live beside the arm they drive —
// `termination-matrix-external.test-support.ts` and
// `termination-matrix-signal.test-support.ts` — because the two arms are two
// functions neither of which can run on the other's platform, and a file holding
// both was a file holding two subjects. This module is the one place that says
// the table is their union, so the suite and its coverage control still read one
// enumeration rather than deciding for themselves which halves to add up.

import { type TerminationCell } from "./termination-matrix-axes.test-support.js";
import { EXTERNAL_ARM_CELLS } from "./termination-matrix-external.test-support.js";
import { SIGNALLED_AND_OBSERVED_CELLS } from "./termination-matrix-signal.test-support.js";

/** Every state the termination path can be asked in, with the verdict each owes. */
export const TERMINATION_MATRIX: readonly TerminationCell[] = [
  ...EXTERNAL_ARM_CELLS,
  ...SIGNALLED_AND_OBSERVED_CELLS,
];
