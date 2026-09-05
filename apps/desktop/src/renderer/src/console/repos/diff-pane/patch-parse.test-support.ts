// What every patch-parse case is driven against: one plain patch, and the two
// accessors that read one out of it.
//
// A SUPPORT MODULE BECAUSE TWO SUITES PARSE THE SAME WAY. `patch-parse.test.ts` owns
// the hunk header, the line kinds, and the intraline segments a changed pair produces;
// `patch-parse.file-shapes.test.ts` owns the files whose whole change is in their
// extended headers. Both parse through the same two fixed arguments — a run
// attribution and a compared-states pair — and a second copy of them in either suite
// would be a second definition of what a patch is being parsed FOR.

import { parseUnifiedPatch } from "./patch-parse.js";
import type { DiffLine } from "./diff-model.js";

/** The two arguments every parse here holds fixed, so a case varies only the patch. */
export const RUN_ATTRIBUTION = { mode: "run_attributed", runId: "run-1" } as const;
export const COMPARED_STATES = { baseRef: "main", headRef: "feat/thing" } as const;

/** A plain unified patch: two files, one hunk each, one modified line pair. */
export const PLAIN_PATCH: string = [
  "--- packages/contracts/src/event.ts",
  "+++ packages/contracts/src/event.ts",
  "@@ -10,2 +10,2 @@",
  " const before = 1;",
  "-const value = compute(previousBudget, 11);",
  "+const value = compute(nextBudget, 11);",
  "--- apps/desktop/src/main.ts",
  "+++ apps/desktop/src/main.ts",
  "@@ -1,1 +1,2 @@",
  " const kept = true;",
  "+const added = true;",
  "",
].join("\n");

/** One parse, under the two arguments every case here holds fixed. */
export function parsePlain(patchText: string): ReturnType<typeof parseUnifiedPatch> {
  return parseUnifiedPatch(patchText, RUN_ATTRIBUTION, COMPARED_STATES);
}

/** The lines of the first hunk of the first file, or a failure that says which. */
export function linesOfFirstHunk(patchText: string): readonly DiffLine[] {
  const hunk = parsePlain(patchText).files[0]?.hunks[0];
  if (hunk === undefined) {
    throw new Error("the patch parsed to no first hunk");
  }
  return hunk.lines;
}
