// Diff models the surfaces are built and measured against, until a wire makes
// one.
//
// THE FIXTURE SHELL FOR AN ABSENT OWNER. `gitflow.diffArtifactCreate` is a
// `Plan-023 §Console growth slate` row (`gitflow-actions`, owned by Spec-011);
// `packages/contracts` exports no `gitflow` module and the growth port registers
// no operation for it, so nothing in the running console can produce a
// `ConsoleDiffModel`. This module is the shell that stands in the producer's
// place — DELETED, not filled, the day a wire hands the console patch bytes,
// along with every import of it. What survives that deletion is `patch-parse.ts`,
// which is the producer itself.
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
// THE SHAPES ARE GENERATED RATHER THAN TRANSCRIBED, because the endurance tier's
// subject is a forty-file, five-thousand-line change set and a transcription of
// one would be a hundred kilobytes of source nobody reads. Generation also makes
// the SIZE a parameter, so the same builder serves a two-line unit case and the
// endurance case with no second implementation.

import type { ConsoleDiffModel, DiffAttribution, DiffLine, DiffLineKind } from "./diff-model.js";
import { parseUnifiedPatch, wholeLineSegments } from "./patch-parse.js";

/** What a generated change set looks like. Every field is a measured dimension. */
export interface DiffFixtureShape {
  readonly fileCount: number;
  readonly hunksPerFile: number;
  readonly linesPerHunk: number;
  /** Hidden context above each hunk, which is what a gap row offers to reveal. */
  readonly precedingContextPerHunk: number;
  /** Every nth line carries trailer-supplied agent attribution. Zero means none. */
  readonly agentAttributionEveryNthLine: number;
}

/** The endurance tier's subject: forty files, five thousand changed lines. */
export const ENDURANCE_DIFF_SHAPE: DiffFixtureShape = {
  fileCount: 40,
  hunksPerFile: 5,
  linesPerHunk: 25,
  precedingContextPerHunk: 30,
  agentAttributionEveryNthLine: 7,
};

/** A change set small enough to assert against row by row. */
export const SMALL_DIFF_SHAPE: DiffFixtureShape = {
  fileCount: 2,
  hunksPerFile: 2,
  linesPerHunk: 3,
  precedingContextPerHunk: 4,
  agentAttributionEveryNthLine: 3,
};

/** The run-attributed arm, for the case the badge renders as accountable to a run. */
export const RUN_ATTRIBUTION: DiffAttribution = {
  mode: "run_attributed",
  runId: "run-rate-limit-wiring",
};

/** The workspace-fallback arm, which carries no run and must never be shown one. */
export const WORKSPACE_FALLBACK_ATTRIBUTION: DiffAttribution = {
  mode: "workspace_fallback",
  workspaceId: "workspace-sidekicks",
};

/** The compared states every generated change set names. */
const FIXTURE_COMPARED_STATES = { baseRef: "main", headRef: "feat/rate-limit-wiring" } as const;

/**
 * The kinds a generated hunk cycles through, so every row branch is reached.
 *
 * Deletion BEFORE insertion, which is not cosmetic: a unified patch expresses a
 * modified line as a delete run immediately followed by an insert run, and that
 * adjacency is what `patch-parse.ts` pairs to compute the intraline segments. A
 * cycle that emitted the insertion first would generate a patch no producer writes
 * and would silently drop every word-level highlight from the fixture.
 */
const LINE_KIND_CYCLE = ["context", "delete", "insert"] as const;

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
  attribution: DiffAttribution = RUN_ATTRIBUTION,
): ConsoleDiffModel {
  const parsed = parseUnifiedPatch(buildPatchText(shape), attribution, FIXTURE_COMPARED_STATES);
  return {
    ...parsed,
    files: parsed.files.map((file) => ({
      path: file.path,
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

/** How many lines a shape's hunks hold. The endurance tier's headline figure. */
export function fixtureChangedLineCount(shape: DiffFixtureShape): number {
  return shape.fileCount * shape.hunksPerFile * shape.linesPerHunk;
}

/** The whole change set as unified patch text, which is what a producer would send. */
function buildPatchText(shape: DiffFixtureShape): string {
  const patches: string[] = [];
  for (let fileOrdinal = 0; fileOrdinal < shape.fileCount; fileOrdinal += 1) {
    const path = fixtureFilePath(fileOrdinal);
    // No `a/` and `b/` prefixes and no `diff --git` line: this is a plain unified
    // patch, so the path the parser reports is the path written here, with nothing
    // to strip and no chance of a re-rooted file reaching a surface.
    const lines: string[] = [`--- ${path}`, `+++ ${path}`];
    for (let hunkOrdinal = 0; hunkOrdinal < shape.hunksPerFile; hunkOrdinal += 1) {
      const start = hunkOrdinal * 40 + 1;
      const body = hunkBodyLines(shape, fileOrdinal, start);
      lines.push(
        `@@ -${String(start)},${String(countSide(body, "-"))} +${String(start)},${String(
          countSide(body, "+"),
        )} @@`,
        ...body,
      );
    }
    patches.push(lines.join("\n"));
  }
  return `${patches.join("\n")}\n`;
}

/** One hunk's prefixed body lines, cycling the three kinds. */
function hunkBodyLines(
  shape: DiffFixtureShape,
  fileOrdinal: number,
  start: number,
): readonly string[] {
  const body: string[] = [];
  for (let lineOrdinal = 0; lineOrdinal < shape.linesPerHunk; lineOrdinal += 1) {
    const kind = LINE_KIND_CYCLE[lineOrdinal % LINE_KIND_CYCLE.length] ?? "context";
    body.push(
      `${PATCH_PREFIX_BY_KIND[kind]}${fixtureLineText(kind, fileOrdinal, start + lineOrdinal)}`,
    );
  }
  return body;
}

/** How many of a hunk's lines exist on one side. A context line exists on both. */
function countSide(body: readonly string[], changedPrefix: "-" | "+"): number {
  return body.filter((line) => line.startsWith(" ") || line.startsWith(changedPrefix)).length;
}

/** The prefix character the unified format gives each kind. */
const PATCH_PREFIX_BY_KIND: Readonly<Record<DiffLineKind, string>> = {
  context: " ",
  insert: "+",
  delete: "-",
};

/**
 * One generated line's text.
 *
 * The two changed kinds differ in exactly one identifier, which is what makes the
 * word diff over the pair produce the three-segment shape a renderer's intraline
 * case is written against — an unchanged head, one changed run, an unchanged tail.
 */
function fixtureLineText(kind: DiffLineKind, fileOrdinal: number, lineNumber: number): string {
  if (kind === "context") {
    return `  const module${padded(fileOrdinal)} = read(${String(lineNumber)});`;
  }
  const identifier = kind === "insert" ? "nextBudget" : "previousBudget";
  return `  const value = compute(${identifier}, ${String(lineNumber)});`;
}

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

/** The path a generated file is written under, in both the patch and the model. */
function fixtureFilePath(fileOrdinal: number): string {
  return `packages/runtime-daemon/src/module-${padded(fileOrdinal)}.ts`;
}

function padded(ordinal: number): string {
  return String(ordinal).padStart(2, "0");
}
