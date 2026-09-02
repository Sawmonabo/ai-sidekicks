// Diff models the surfaces are built and measured against, until a wire makes
// one.
//
// THE FIXTURE SHELL FOR AN ABSENT OWNER. `gitflow.diffArtifactCreate` is a
// `Plan-023 §Console growth slate` row (`gitflow-actions`, owned by Spec-011);
// `packages/contracts` exports no `gitflow` module and the growth port registers
// no operation for it, so nothing in the running console can produce a
// `ConsoleDiffModel`. This module is the shell that stands in the producer's
// place — DELETED, not filled, the day the parse-and-compute module lands, along
// with every import of it.
//
// IT IS NOT IMPORTED BY ANY RENDERING PATH. The pane and the card take their
// model as a prop and render an honest absence without one; only tests reach for
// this file. That is deliberate: a fixture the application could reach is a
// fixture that can ship, and the console's one legitimate fixture seam is the
// bridge's, gated by `__SIDEKICKS_CONSOLE_FIXTURES__`.
//
// THE SHAPES ARE GENERATED RATHER THAN TRANSCRIBED, because the endurance tier's
// subject is a forty-file, five-thousand-line change set and a transcription of
// one would be a hundred kilobytes of source nobody reads. Generation also makes
// the SIZE a parameter, so the same builder serves a two-line unit case and the
// endurance case with no second implementation.

import type {
  ConsoleDiffModel,
  DiffAttribution,
  DiffFile,
  DiffHunk,
  DiffLine,
} from "./diff-model.js";

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

/**
 * Build a diff of a named shape.
 *
 * The line kinds cycle context / insert / delete so every renderer branch is
 * exercised by any shape with three or more lines in a hunk, and the intraline
 * segmentation lands on the insert and delete lines only — which is where a real
 * word diff puts it, and which keeps a context line's `segments` the
 * single-unchanged-segment case every consumer has to handle anyway.
 */
export function buildDiffFixture(
  shape: DiffFixtureShape,
  attribution: DiffAttribution = RUN_ATTRIBUTION,
): ConsoleDiffModel {
  const files: DiffFile[] = [];
  for (let fileOrdinal = 0; fileOrdinal < shape.fileCount; fileOrdinal += 1) {
    const hunks: DiffHunk[] = [];
    for (let hunkOrdinal = 0; hunkOrdinal < shape.hunksPerFile; hunkOrdinal += 1) {
      hunks.push({
        header: `@@ -${String(hunkOrdinal * 40 + 1)},${String(shape.linesPerHunk)} +${String(
          hunkOrdinal * 40 + 1,
        )},${String(shape.linesPerHunk)} @@`,
        precedingContext: buildLines(shape, fileOrdinal, hunkOrdinal, true),
        lines: buildLines(shape, fileOrdinal, hunkOrdinal, false),
      });
    }
    files.push({ path: `packages/runtime-daemon/src/module-${padded(fileOrdinal)}.ts`, hunks });
  }
  return { attribution, baseRef: "main", headRef: "feat/rate-limit-wiring", files };
}

/** How many changed lines a shape produces. The endurance tier's headline figure. */
export function fixtureChangedLineCount(shape: DiffFixtureShape): number {
  return shape.fileCount * shape.hunksPerFile * shape.linesPerHunk;
}

function buildLines(
  shape: DiffFixtureShape,
  fileOrdinal: number,
  hunkOrdinal: number,
  isPrecedingContext: boolean,
): DiffLine[] {
  const count = isPrecedingContext ? shape.precedingContextPerHunk : shape.linesPerHunk;
  const lines: DiffLine[] = [];
  for (let lineOrdinal = 0; lineOrdinal < count; lineOrdinal += 1) {
    const kind = isPrecedingContext ? "context" : LINE_KIND_CYCLE[lineOrdinal % 3];
    const baseNumber = hunkOrdinal * 40 + lineOrdinal + 1;
    const carriesAttribution =
      shape.agentAttributionEveryNthLine > 0 &&
      !isPrecedingContext &&
      lineOrdinal % shape.agentAttributionEveryNthLine === 0;
    const resolvedKind = kind ?? "context";
    // Spread-in rather than `: undefined`. Under `exactOptionalPropertyTypes` an
    // optional member assigned `undefined` is a different type from an absent
    // one, and the model means the second: an inserted line HAS no base number.
    lines.push({
      kind: resolvedKind,
      ...(resolvedKind === "insert" ? {} : { baseLineNumber: baseNumber }),
      ...(resolvedKind === "delete" ? {} : { headLineNumber: baseNumber }),
      segments:
        resolvedKind === "context"
          ? [
              {
                text: `  const module${padded(fileOrdinal)} = read(${String(baseNumber)});`,
                changed: false,
              },
            ]
          : [
              { text: "  const value = compute(", changed: false },
              { text: resolvedKind === "insert" ? "nextBudget" : "previousBudget", changed: true },
              { text: `, ${String(baseNumber)});`, changed: false },
            ],
      ...(carriesAttribution
        ? { agentAttribution: { agentRunId: "run-rate-limit-wiring", agentName: "Implementer" } }
        : {}),
    });
  }
  return lines;
}

/** The kinds a generated hunk cycles through, so every row branch is reached. */
const LINE_KIND_CYCLE = ["context", "insert", "delete"] as const;

function padded(ordinal: number): string {
  return String(ordinal).padStart(2, "0");
}
