// Diff models the surfaces are built and measured against, until a wire makes one.
//
// THE FIXTURE SHELL FOR AN ABSENT OWNER. `gitflow.diffArtifactCreate` is a
// `Plan-023 §Console growth slate` row (`gitflow-actions`, owned by Spec-011);
// `packages/contracts` exports no `gitflow` module and the growth port registers
// no operation for it, so nothing in the running console can produce a
// `ConsoleDiffModel`. This module is the shell that stands in the producer's
// place — DELETED, not filled, the day a wire hands the console patch bytes,
// along with `diff-fixture-shapes.test-support.ts`, `diff-fixture-patch.test-support.ts`, and every import
// of the three. What survives that deletion is `patch-parse.ts`, which is the
// producer itself.
//
// IT IS NOT IMPORTED BY ANY RENDERING PATH. The pane and the card take their
// model as a prop and render an honest absence without one; only tests reach for
// this file. That is deliberate: a fixture the application could reach is a
// fixture that can ship, and the console's one legitimate fixture seam is the
// bridge's, gated by `__SIDEKICKS_CONSOLE_FIXTURES__`.
//
// IT GENERATES A PATCH AND PARSES IT, rather than assembling the model directly.
// `Spec-023 §Console Libraries` adopts `diff` 9.0.0 for parse and intraline
// compute, and a fixture that hand-built hunk headers, line numbers, and word-level
// segments would be a second implementation of exactly that — one the tiers would
// then be measuring INSTEAD of the parser a wire will call. Two things this buys
// beyond the deletion: the line numbers are the ones the format produces (a base
// number and a head number advance on different sides, which a hand-built lockstep
// gets wrong), and the intraline segments are jsdiff's, so a renderer case that
// passes here passes against real word-diff output.
//
// WHAT THIS MODULE ITSELF DOES is the part a patch cannot: the hidden context above
// each hunk, which the unified format has no representation for at all, and the
// trailer-supplied agent attribution, which lives on the commit rather than in the
// patch body. The shapes are `diff-fixture-shapes.test-support.ts`'s and the patch text is
// `diff-fixture-patch.test-support.ts`'s.

import { buildPatchText } from "./diff-fixture-patch.test-support.js";
import {
  RUN_ATTRIBUTED_ATTRIBUTION,
  type DiffFixtureShape,
} from "./diff-fixture-shapes.test-support.js";
import type { ConsoleDiffModel, DiffAttribution, DiffLine } from "./diff-model.js";
import { wholeLineSegments } from "./diff-model.js";
import { parseUnifiedPatch } from "./patch-parse.js";

const FIXTURE_COMPARED_STATES = { baseRef: "main", headRef: "feat/rate-limit-wiring" } as const;

/**
 * Build a diff of a named shape.
 *
 * The patch is generated, parsed, and then given the two things a patch cannot
 * carry: the hidden context above each hunk (`patch-parse.ts` explains why a parsed
 * hunk has none) and the trailer-supplied agent attribution, which lives on the
 * commit rather than in the patch body.
 */
export function buildDiffFixture(
  shape: DiffFixtureShape,
  attribution: DiffAttribution = RUN_ATTRIBUTED_ATTRIBUTION,
): ConsoleDiffModel {
  const parsed = parseUnifiedPatch(buildPatchText(shape), attribution, FIXTURE_COMPARED_STATES);
  return {
    ...parsed,
    files: parsed.files.map((file) => ({
      // SPREAD, so what the parser read off the extended headers survives. Rebuilding
      // the file from `path` and `hunks` alone is exactly the drop this fixture would
      // otherwise reintroduce below the parser that stopped making it.
      ...file,
      hunks: file.hunks.map((hunk, hunkOrdinal) => ({
        header: hunk.header,
        precedingContext: buildPrecedingContext(shape, file.path, hunkOrdinal),
        lines: hunk.lines.map((line, lineOrdinal) =>
          withAgentAttribution(shape, line, lineOrdinal),
        ),
      })),
    })),
  };
}

/**
 * How many lines a shape's hunks hold. The endurance tier's headline figure.
 *
 * The terminator file's pair is counted because it IS a pair of changed lines; the
 * four header files add none, which is why they need no term here.
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
 * Context by construction — every line is a context line, because that is what a
 * gap between two hunks holds — and built rather than parsed, for `patch-parse.ts`'s
 * reason: a unified patch has no representation for it at all.
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

/** Every nth line carries the trailers' attribution; the rest carry none. */
function withAgentAttribution(
  shape: DiffFixtureShape,
  line: DiffLine,
  lineOrdinal: number,
): DiffLine {
  if (
    shape.agentAttributionEveryNthLine <= 0 ||
    lineOrdinal % shape.agentAttributionEveryNthLine !== 0
  ) {
    return line;
  }
  return {
    ...line,
    agentAttribution: { agentRunId: "run-rate-limit-wiring", agentName: "Implementer" },
  };
}
