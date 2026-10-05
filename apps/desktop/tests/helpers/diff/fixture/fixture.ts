// Diff models the diff views are built and measured against, until a wire produces one.
//
// Nothing in the running app produces a `DiffModel` (no daemon method returns patch bytes), so
// this fixture stands in for the producer. It is deleted when a wire supplies patch bytes, along
// with `diff-fixture-shapes.ts`, `patch.test-support.ts` and their imports;
// `patch-parse.ts` is the real producer and stays. Only tests import it, so it cannot ship.
//
// It generates a patch and parses it rather than building the model by hand, so the tiers measure
// the parser a wire will call: line numbers advance on the base and head sides as the format says,
// and intraline segments are jsdiff's word diff. This module adds only the hidden context above
// each hunk, which the unified format cannot represent.

import { buildPatchText } from "./patch.test-support.js";
import type { DiffFixtureShape } from "./diff-fixture-shapes.js";
import type { DiffModel, DiffLine } from "@renderer/features/repos/diff/diff-model.js";
import { wholeLineSegments } from "@renderer/features/repos/diff/diff-model.js";
import { parseUnifiedPatch } from "@renderer/features/repos/diff/patch-parse.js";

const FIXTURE_COMPARED_STATES = { baseRef: "main", headRef: "feat/rate-limit-wiring" } as const;

/**
 * Builds a diff of a named shape.
 *
 * The patch is generated and parsed, then given the hidden context above each hunk, which a parsed
 * hunk lacks.
 */
export function buildDiffFixture(shape: DiffFixtureShape): DiffModel {
  const parsed = parseUnifiedPatch(buildPatchText(shape), FIXTURE_COMPARED_STATES);
  return {
    ...parsed,
    files: parsed.files.map((file) => ({
      // Spread so what the parser read off the extended headers survives.
      ...file,
      hunks: file.hunks.map((hunk, hunkOrdinal) => ({
        header: hunk.header,
        precedingContext: buildPrecedingContext(shape, file.path, hunkOrdinal),
        lines: hunk.lines,
      })),
    })),
  };
}

/**
 * How many changed lines a shape's hunks hold: the endurance tier's headline figure.
 *
 * The terminator file's deleted and inserted pair counts; the header files add none.
 */
export function fixtureChangedLineCount(shape: DiffFixtureShape): number {
  return (
    shape.fileCount * shape.hunksPerFile * shape.linesPerHunk +
    (shape.terminalNewlineFile ? TERMINAL_NEWLINE_CHANGED_LINE_COUNT : 0)
  );
}

/** The deletion and the insertion the terminator file's one hunk carries. */
const TERMINAL_NEWLINE_CHANGED_LINE_COUNT = 2;

/**
 * The hidden context above one hunk.
 *
 * Every line is context, as a gap between two hunks holds, and it is built rather than parsed
 * because a unified patch cannot represent it.
 */
function buildPrecedingContext(
  shape: DiffFixtureShape,
  path: string,
  hunkOrdinal: number,
): readonly DiffLine[] {
  const lines: DiffLine[] = [];
  for (let lineOrdinal = 0; lineOrdinal < shape.precedingContextPerHunk; lineOrdinal += 1) {
    const lineNumber = hunkOrdinal * 40 + lineOrdinal + 1;
    lines.push({
      kind: "context",
      baseLineNumber: lineNumber,
      headLineNumber: lineNumber,
      segments: wholeLineSegments(`  // ${path}:${String(lineNumber)}`),
    });
  }
  return lines;
}
