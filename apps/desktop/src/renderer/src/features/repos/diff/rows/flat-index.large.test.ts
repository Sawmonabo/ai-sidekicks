// One view handed a body far larger than anything it is scrolled through, held open and worked.
// A forty-file, five-thousand-line change set is the shape the diff feature is written against,
// and every property here holds at ten rows and can quietly stop holding at five thousand.
//
// The subject is the diff's flattening (`flat-index.ts`), arithmetic over a model that
// touches no DOM, so the claims are checkable in milliseconds with no bundle to build. The window
// over those rows is `@tanstack/react-virtual`'s and is asserted against the DOM in
// `DiffRenderer.test.ts`.
//
// It asserts four things the small-diff cases in `flat-index.test.ts` cannot:
//
// 1. Cost does not scale with the diff. Flattening is paid once per expansion, and a scroll
//    costs a handful of `rowAt` reads bounded by the viewport; a `rowAt` that walked from the
//    top would pass every small case and make a scroll to row 5,000 cost 5,000 steps.
// 2. Sustained work retains nothing: a hundred gap expansions leave no growing structure, the
//    leak class a small diff cannot show.
// 3. Every row is addressable, not a sample: every one of the ~6,600 rows resolves to a row
//    value and every line row to a line, since an off-by-one in the per-file walk shows up as
//    one unreachable row that no spot check finds.
// 4. One pathological line costs no more than the patch around it. A word diff over every
//    changed pair is quadratic in tokens, so one 20,000-character line would cost more than the
//    other five thousand together; no fixture of uniform lines contains that shape.

import { describe, expect, it } from "vitest";

import { buildDiffFixture, fixtureChangedLineCount } from "#test/helpers/diff/fixture/model.js";
import {
  ENDURANCE_DIFF_SHAPE,
  SINGLE_LARGE_HUNK_DIFF_SHAPE,
} from "#test/helpers/diff/fixture/shapes.js";
import { diffLineText, type DiffLine } from "../model.js";
import { diffGapKey, expandGap, type DiffGapExpansion, type DiffLineRow } from "./model.js";
import { DiffRowIndex } from "./flat-index.js";
import { IntralineSegmentCache } from "../intraline-segment-cache.js";
import { parseUnifiedPatch } from "../patch-parse.js";

const ENDURANCE_DIFF = buildDiffFixture(ENDURANCE_DIFF_SHAPE);

/**
 * The same five thousand lines in one hunk of one file. A second shape, because forty files of
 * five twenty-five-line hunks bound every per-hunk cost at twenty-five, while a generated file,
 * a lockfile or a rewritten module puts the whole change in one hunk.
 */
const SINGLE_LARGE_HUNK_DIFF = buildDiffFixture(SINGLE_LARGE_HUNK_DIFF_SHAPE);

describe("a forty-file, five-thousand-line diff", () => {
  it("addresses every row, and resolves every line row to a line", () => {
    const index = new DiffRowIndex(ENDURANCE_DIFF);
    let lineRowCount = 0;
    for (let rowIndex = 0; rowIndex < index.rowCount; rowIndex += 1) {
      const row = index.rowAt(rowIndex);
      // Asserted inside the loop so a failure names its row rather than dumping 6,600 rows.
      if (row === undefined) {
        throw new Error(`row ${String(rowIndex)} of ${String(index.rowCount)} is unaddressable`);
      }
      if (row.kind === "line") {
        lineRowCount += 1;
        expect(index.lineFor(row)).toBeDefined();
      }
    }
    expect(lineRowCount).toBe(fixtureChangedLineCount(ENDURANCE_DIFF_SHAPE));
  });

  it("costs no more per scroll at the end of the diff than at its start", () => {
    // The claim the flattening's binary search exists for: a `rowAt` that walked from the top
    // would make the tail a multiple of the head on any runner.
    expectTailReadsAsCheapAsHead(new DiffRowIndex(ENDURANCE_DIFF));
  });

  it("retains nothing across sustained expansion, and the expansion stays monotonic", () => {
    // Expansion is the one operation that grows a structure. A hundred gaps expanded to
    // exhaustion should leave a map with a hundred entries, not one per activation or scroll.
    let expansion: DiffGapExpansion = new Map();
    const gapsTouched = new Set<string>();
    const activationCount = ENDURANCE_DIFF_SHAPE.fileCount * ENDURANCE_DIFF_SHAPE.hunksPerFile * 4;
    for (let activation = 0; activation < activationCount; activation += 1) {
      const fileIndex = activation % ENDURANCE_DIFF_SHAPE.fileCount;
      const hunkIndex =
        Math.floor(activation / ENDURANCE_DIFF_SHAPE.fileCount) % ENDURANCE_DIFF_SHAPE.hunksPerFile;
      // The real key function, not a second copy of its format.
      const key = diffGapKey(fileIndex, hunkIndex);
      gapsTouched.add(key);
      const previous = expansion.get(key) ?? 0;
      expansion = expandGap(
        expansion,
        fileIndex,
        hunkIndex,
        ENDURANCE_DIFF_SHAPE.precedingContextPerHunk,
      );
      // Asserted on every activation: one non-monotonic step is invisible in a final count.
      expect(expansion.get(key) ?? 0).toBeGreaterThanOrEqual(previous);
    }
    // One entry per gap, not per activation: state that grew with clicks is the leak.
    expect(expansion.size).toBe(gapsTouched.size);

    // Fully expanded, the diff is bigger and every row is still addressable; an off-by-one in
    // the revealed-context walk shows up here.
    const expanded = new DiffRowIndex(ENDURANCE_DIFF, expansion);
    expect(expanded.rowCount).toBeGreaterThan(new DiffRowIndex(ENDURANCE_DIFF).rowCount);
    expect(expanded.rowAt(expanded.rowCount - 1)).toBeDefined();
    expect(expanded.rowAt(expanded.rowCount)).toBeUndefined();
  });

  it("flattens one five-thousand-line hunk once, and reads rows out of it for free", () => {
    // The claim the per-hunk layout cache exists for, observable at this size: without it
    // `rowAt` would rebuild a hunk's whole body layout, allocating five thousand row objects per
    // rendered virtual row on every scroll render.
    const index = new DiffRowIndex(SINGLE_LARGE_HUNK_DIFF);
    expect(fixtureChangedLineCount(SINGLE_LARGE_HUNK_DIFF_SHAPE)).toBe(5000);
    expect(SINGLE_LARGE_HUNK_DIFF.files).toHaveLength(1);
    expect(index.bodyLayoutBuildCount).toBe(1);

    const viewportRowCount = 60;
    for (let scroll = 0; scroll < 50; scroll += 1) {
      const top = Math.floor((index.rowCount - viewportRowCount) * (scroll / 50));
      for (let offset = 0; offset < viewportRowCount; offset += 1) {
        expect(index.rowAt(top + offset)).toBeDefined();
      }
    }
    // Fifty viewports of sixty rows, and not one further flattening.
    expect(index.bodyLayoutBuildCount).toBe(1);
  });

  it("costs no more per scroll deep inside one hunk than at its top", () => {
    // The forty-file ratio claim, asked of the addressing inside one span rather than across
    // spans: a `rowAt` that walked a hunk's body would make the tail a multiple of the head.
    expectTailReadsAsCheapAsHead(new DiffRowIndex(SINGLE_LARGE_HUNK_DIFF));
  });
});

/**
 * How many changed lines the pathological patch carries, and how wide its worst one is. The
 * case is about their interaction: five thousand ordinary lines make a realistic change set,
 * and one line two orders of magnitude wider makes the word diff quadratic. Either alone
 * measures nothing.
 */
const PATHOLOGICAL_PATCH_LINE_COUNT = 5_000;
const PATHOLOGICAL_LINE_TOKEN_COUNT = 1_200;

/**
 * What parsing that patch may cost, in milliseconds. An absolute, unlike the ratios elsewhere
 * in this file, because there is no second measurement to take a ratio against. It sits between
 * two measurements: 1.6 ms for this patch on a developer machine, and 831 ms when parsing
 * segmented every pair. That is two orders of magnitude of headroom over the first and well
 * under the second, so it fails on a regression and never on a loaded runner.
 */
const PATHOLOGICAL_PARSE_BUDGET_MS = 200;

describe("one pathological line inside a five-thousand-line patch", () => {
  it("parses inside its budget, and the wide row falls back rather than being compared", () => {
    const patchText = pathologicalPatchText();
    const startedAt = performance.now();
    const model = parseUnifiedPatch(patchText, { baseRef: "main", headRef: "feat/large-diff" });
    const parseMilliseconds = performance.now() - startedAt;

    // The subject in numbers first, so a generator that quietly shrank cannot pass.
    const lines = model.files[0]?.hunks[0]?.lines ?? [];
    expect(lines).toHaveLength(PATHOLOGICAL_PATCH_LINE_COUNT);
    const widestLineLength = diffLineText(lines[0] as DiffLine).length;
    expect(widestLineLength).toBeGreaterThan(20_000);
    expect(parseMilliseconds).toBeLessThan(PATHOLOGICAL_PARSE_BUDGET_MS);

    // The row a reader scrolls to keeps its whole line, unsplit: the cost is not moved from
    // parse into the row, it is not paid at all.
    const cache = new IntralineSegmentCache(model);
    expect(cache.readingFor(pathologicalBodyRow(0), 0).segments).toStrictEqual([
      { text: diffLineText(lines[0] as DiffLine), changed: false },
    ]);
  });
});

/** A body row of the pathological patch's single hunk. */
function pathologicalBodyRow(lineIndex: number): DiffLineRow {
  return { kind: "line", fileIndex: 0, hunkIndex: 0, source: "hunk-body", lineIndex };
}

/**
 * A five-thousand-line patch whose first changed pair is two very wide lines. It lives here,
 * not in the shared diff fixtures, because it is one deliberately hostile input rather than a
 * shape the views render. The wide line is many short tokens because the word diff is quadratic
 * in tokens, and a single long token would be cheap for the reason a real minified line is not.
 */
function pathologicalPatchText(): string {
  const wideLine = (token: string): string => {
    const tokens: string[] = [];
    for (let ordinal = 0; ordinal < PATHOLOGICAL_LINE_TOKEN_COUNT; ordinal += 1) {
      tokens.push(`${token}${String(ordinal)}`);
    }
    return tokens.join(" ");
  };
  const body: string[] = [`-${wideLine("previousBudget")}`, `+${wideLine("nextBudget")}`];
  while (body.length < PATHOLOGICAL_PATCH_LINE_COUNT) {
    const ordinal = body.length;
    body.push(`-const value = compute(previousBudget, ${String(ordinal)});`);
    body.push(`+const value = compute(nextBudget, ${String(ordinal)});`);
  }
  const sideLength = body.length / 2;
  return [
    "--- packages/runtime-daemon/src/module-00.ts",
    "+++ packages/runtime-daemon/src/module-00.ts",
    `@@ -1,${String(sideLength)} +1,${String(sideLength)} @@`,
    ...body,
    "",
  ].join("\n");
}

/** How many times each band is timed; the fastest of them is the band's cost. */
const ROW_READ_TRIAL_COUNT = 21;

/** The coarsest step a page's `performance.now()` may report, a tenth of a millisecond. */
const TIMER_STEP_MILLISECONDS = 0.1;

/** How many reads one trial makes, cycling through its band, so a trial outlasts timer noise. */
const ROW_READS_PER_TRIAL = 5_000;

/**
 * Asserts that reading the last hundredth of `index`'s rows costs no multiple of reading the
 * first. A claim about the algorithm, not the runner, so neither band's time is taken from one
 * run: the two are timed in alternation, many times over, and each band's fastest trial is its
 * cost. A busy machine only ever adds time, so a trial it slows is outrun by one it left alone,
 * and the alternation hands the head and the tail the same machine.
 */
function expectTailReadsAsCheapAsHead(index: DiffRowIndex): void {
  const bandRowCount = Math.floor(index.rowCount / 100);
  const tailStartRowIndex = index.rowCount - bandRowCount;
  let headMilliseconds = Number.POSITIVE_INFINITY;
  let tailMilliseconds = Number.POSITIVE_INFINITY;
  for (let trial = 0; trial < ROW_READ_TRIAL_COUNT; trial += 1) {
    headMilliseconds = Math.min(headMilliseconds, timeRowReads(index, 0, bandRowCount));
    tailMilliseconds = Math.min(
      tailMilliseconds,
      timeRowReads(index, tailStartRowIndex, bandRowCount),
    );
  }
  // The tail may cost a little more, never a multiple: a walk from the top costs it hundreds. The
  // head counts as at least one timer step, so a head that read as no time cannot fail the tail.
  expect(tailMilliseconds).toBeLessThan(Math.max(headMilliseconds, TIMER_STEP_MILLISECONDS) * 4);
}

/** Read a band of rows over and over, and report how long the reads took, in milliseconds. */
function timeRowReads(index: DiffRowIndex, startRowIndex: number, bandRowCount: number): number {
  const startedAt = performance.now();
  for (let read = 0; read < ROW_READS_PER_TRIAL; read += 1) {
    if (index.rowAt(startRowIndex + (read % bandRowCount)) === undefined) {
      throw new Error(`row ${String(startRowIndex + (read % bandRowCount))} is unaddressable`);
    }
  }
  return performance.now() - startedAt;
}
