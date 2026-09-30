// What every patch-parse case is driven against: one plain patch and the two accessors that read
// one out of it.
//
// Shared by `patch-parse.test.ts` (hunk header, line kinds, intraline segments) and
// `patch-parse.file-shapes.test.ts` (files whose change is in their extended headers), which
// parse through the same fixed compared-states pair.

import { parseUnifiedPatch } from "@renderer/features/repos/diff/patch-parse.js";
import type { DiffLine } from "@renderer/features/repos/diff/diff-model.js";

/** The argument every parse here holds fixed, so a case varies only the patch. */
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

/** One parse, under the compared states every case here holds fixed. */
export function parsePlainPatch(patchText: string): ReturnType<typeof parseUnifiedPatch> {
  return parseUnifiedPatch(patchText, COMPARED_STATES);
}

/** The lines of the first hunk of the first file, or a failure that says which. */
export function linesOfFirstHunk(patchText: string): readonly DiffLine[] {
  const hunk = parsePlainPatch(patchText).files[0]?.hunks[0];
  if (hunk === undefined) {
    throw new Error("the patch parsed to no first hunk");
  }
  return hunk.lines;
}
