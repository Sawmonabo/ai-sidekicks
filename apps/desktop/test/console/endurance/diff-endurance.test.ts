// Tier: endurance — `Spec-023 §Console Test Tiers`.
//
// `steady-state.test.ts` beside this file measures the console held open for a
// working day. This one measures the other endurance case a desktop console has:
// one surface handed a body far larger than anything it is scrolled through, held
// open, and worked. A forty-file, five-thousand-line change set is the shape the diff
// family is written against, and every property this file asserts is one that
// holds at ten rows and quietly stops holding at five thousand.
//
// WHY THIS RUNS IN THE NODE PROJECT AND OPENS NO ELECTRON WINDOW
//
// The subject is the diff's flattening — `hunk-virtualization.ts` — which is
// arithmetic over a model and touches no DOM. That separation is deliberate in
// the module and this file is what cashes it: the endurance claims about a
// five-thousand-line diff are checkable in milliseconds, deterministically, on
// any runner, with no bundle to build and no window to launch. The WINDOW over
// those rows is `@tanstack/react-virtual`'s and is asserted against the DOM in
// `DiffRenderer.test.tsx` — at the same five-thousand-line fixture, against a
// measured viewport, where a wrapped row can have a height at all. Restating it
// here would be a claim about arithmetic this module no longer performs.
//
// So this tier is not "the same cases again with a bigger fixture". It asserts
// four things the unit tier cannot:
//
//   1. COST DOES NOT SCALE WITH THE DIFF. Flattening is paid once per expansion,
//      and a scroll — the thing a person does thousands of times — costs a
//      handful of `rowAt` reads whose work is bounded by the viewport. A `rowAt`
//      that walked from the top would satisfy every unit case and make a scroll
//      to row 5,000 cost 5,000 steps.
//   2. SUSTAINED WORK RETAINS NOTHING. A hundred gap expansions leave no growing
//      structure behind, which is the leak class a fast tier cannot see.
//   3. EVERY ROW IS ADDRESSABLE. Not a sample — every one of the ~6,600 rows
//      resolves to a row value, and every line row resolves to a line. An
//      off-by-one in the per-file walk shows up as one unreachable row somewhere
//      in the middle, which no spot check finds.
//   4. ONE PATHOLOGICAL LINE COSTS NO MORE THAN THE PATCH AROUND IT. Parsing used
//      to run the word diff over every changed pair, whose cost is quadratic in
//      tokens — so a single 20,000-character line cost more than the other five
//      thousand put together and paid it before a row was drawn. That is a shape
//      no fixture built from uniform lines contains.

import process from "node:process";

import { describe, expect, it } from "vitest";

import {
  buildDiffFixture,
  fixtureChangedLineCount,
} from "../../../src/renderer/src/console/repos/diff-pane/diff-fixture.js";
import {
  ENDURANCE_DIFF_SHAPE,
  SINGLE_LARGE_HUNK_DIFF_SHAPE,
} from "../../../src/renderer/src/console/repos/diff-pane/diff-fixture-shapes.js";
import {
  diffLineText,
  type DiffLine,
} from "../../../src/renderer/src/console/repos/diff-pane/diff-model.js";
import {
  diffGapKey,
  expandGap,
  type DiffGapExpansion,
  type DiffLineRow,
} from "../../../src/renderer/src/console/repos/diff-pane/diff-row-model.js";
import { DiffRowIndex } from "../../../src/renderer/src/console/repos/diff-pane/hunk-virtualization.js";
import { IntralineSegmentCache } from "../../../src/renderer/src/console/repos/diff-pane/intraline-segments.js";
import { parseUnifiedPatch } from "../../../src/renderer/src/console/repos/diff-pane/patch-parse.js";

const ENDURANCE_DIFF = buildDiffFixture(ENDURANCE_DIFF_SHAPE);

/**
 * The same five thousand lines in one hunk of one file.
 *
 * A SECOND SHAPE RATHER THAN A WIDER FIRST ONE, because the two measure different
 * costs and neither substitutes for the other. Forty files of five twenty-five-line
 * hunks bounds every per-hunk cost at twenty-five, so a per-lookup flattening of a
 * whole hunk stayed under the noise floor there — while the diff a pane actually meets
 * on a generated file, a lockfile, or a rewritten module puts the whole change in one
 * hunk, where that same cost is the change set.
 */
const SINGLE_LARGE_HUNK_DIFF = buildDiffFixture(SINGLE_LARGE_HUNK_DIFF_SHAPE);

describe("endurance — a forty-file, five-thousand-line diff", () => {
  it("flattens the whole change set and reports its true row count", () => {
    const index = new DiffRowIndex(ENDURANCE_DIFF);
    // The subject is stated in numbers before anything is asserted about it, so a
    // fixture that quietly shrank could never make this tier pass by measuring
    // something smaller.
    expect(fixtureChangedLineCount(ENDURANCE_DIFF_SHAPE)).toBe(5000);
    expect(ENDURANCE_DIFF.files).toHaveLength(40);
    expect(index.rowCount).toBeGreaterThan(5000);
    process.stdout.write(
      `[console-endurance] diff: ${String(ENDURANCE_DIFF.files.length)} files, ` +
        `${String(fixtureChangedLineCount(ENDURANCE_DIFF_SHAPE))} changed lines, ` +
        `${String(index.rowCount)} rows\n`,
    );
  });

  it("addresses every row, and resolves every line row to a line", () => {
    const index = new DiffRowIndex(ENDURANCE_DIFF);
    let lineRowCount = 0;
    for (let rowIndex = 0; rowIndex < index.rowCount; rowIndex += 1) {
      const row = index.rowAt(rowIndex);
      // Asserting inside the loop rather than collecting and comparing: at this
      // size a failure should name the row it happened at, and a collected array
      // of 6,600 rows in an assertion message names none of them.
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
    // The claim the flattening's binary search exists for. Ratio rather than an
    // absolute duration, because an absolute is a claim about the runner and this
    // is a claim about the algorithm: a `rowAt` that walked from the top would
    // make the tail arbitrarily slower than the head, and the ratio catches that
    // on a fast runner and a slow one alike.
    const index = new DiffRowIndex(ENDURANCE_DIFF);
    const headMilliseconds = timeRowReads(index, 0, index.rowCount / 100);
    const tailMilliseconds = timeRowReads(
      index,
      Math.floor(index.rowCount * 0.99),
      index.rowCount / 100,
    );
    process.stdout.write(
      `[console-endurance] rowAt: head ${headMilliseconds.toFixed(2)} ms, ` +
        `tail ${tailMilliseconds.toFixed(2)} ms\n`,
    );
    // A generous ceiling: the point is that the tail is not a MULTIPLE of the
    // head, and timing noise on a shared runner is worth more headroom than
    // precision is worth here.
    expect(tailMilliseconds).toBeLessThan(Math.max(headMilliseconds * 8, 1));
  });

  it("retains nothing across sustained expansion, and the expansion stays monotonic", () => {
    // Expansion is the one operation that grows a structure, so it is the one
    // worth driving hard. A hundred gaps expanded to exhaustion should leave a
    // map with a hundred entries — not one entry per activation, and not one per
    // scroll that happened in between.
    let expansion: DiffGapExpansion = new Map();
    const gapsTouched = new Set<string>();
    const activationCount = ENDURANCE_DIFF_SHAPE.fileCount * ENDURANCE_DIFF_SHAPE.hunksPerFile * 4;
    for (let activation = 0; activation < activationCount; activation += 1) {
      const fileIndex = activation % ENDURANCE_DIFF_SHAPE.fileCount;
      const hunkIndex =
        Math.floor(activation / ENDURANCE_DIFF_SHAPE.fileCount) % ENDURANCE_DIFF_SHAPE.hunksPerFile;
      // The real key function, not a second copy of its format — the producer and
      // the reader of a key share a module for the reason the structure rules give.
      const key = diffGapKey(fileIndex, hunkIndex);
      gapsTouched.add(key);
      const previous = expansion.get(key) ?? 0;
      expansion = expandGap(
        expansion,
        fileIndex,
        hunkIndex,
        ENDURANCE_DIFF_SHAPE.precedingContextPerHunk,
      );
      // Predecessor retention, asserted on every single activation rather than at
      // the end: a single non-monotonic step would be invisible in a final count.
      expect(expansion.get(key) ?? 0).toBeGreaterThanOrEqual(previous);
    }
    // One entry per GAP, not one per activation. An expansion state that grew
    // with the number of clicks is the retention leak this tier is here for.
    expect(expansion.size).toBe(gapsTouched.size);

    // Fully expanded, the diff is bigger and every row is still addressable —
    // which is the state a reader who worked through a large change set ends in
    // and the one an off-by-one in the revealed-context walk shows up in.
    const expanded = new DiffRowIndex(ENDURANCE_DIFF, expansion);
    expect(expanded.rowCount).toBeGreaterThan(new DiffRowIndex(ENDURANCE_DIFF).rowCount);
    expect(expanded.rowAt(expanded.rowCount - 1)).toBeDefined();
    expect(expanded.rowAt(expanded.rowCount)).toBeUndefined();
  });

  it("flattens one five-thousand-line hunk once, and reads rows out of it for free", () => {
    // The claim the per-hunk layout cache exists for, stated where the size makes it
    // observable: `rowAt` used to rebuild the whole body layout of every hunk it
    // walked past, so a single hunk this size allocated five thousand row objects per
    // rendered virtual row and again on every scroll render.
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
    process.stdout.write(
      `[console-endurance] one hunk: ${String(index.rowCount)} rows, ` +
        `${String(index.bodyLayoutBuildCount)} body layouts built\n`,
    );
  });

  it("costs no more per scroll deep inside one hunk than at its top", () => {
    // The same ratio claim the forty-file case makes, asked of the addressing INSIDE
    // a span rather than across spans. A `rowAt` that walked a hunk's body to reach a
    // row would make the tail of this diff a multiple of its head.
    const index = new DiffRowIndex(SINGLE_LARGE_HUNK_DIFF);
    const headMilliseconds = timeRowReads(index, 0, index.rowCount / 100);
    const tailMilliseconds = timeRowReads(
      index,
      Math.floor(index.rowCount * 0.99),
      index.rowCount / 100,
    );
    process.stdout.write(
      `[console-endurance] one hunk rowAt: head ${headMilliseconds.toFixed(2)} ms, ` +
        `tail ${tailMilliseconds.toFixed(2)} ms\n`,
    );
    expect(tailMilliseconds).toBeLessThan(Math.max(headMilliseconds * 8, 1));
  });

  it("negative control: the read band is a fraction of the diff it is read from", () => {
    // Without this the timing case above would pass over a diff small enough that
    // a walk from the top costs nothing — which is to say, over no flattening at
    // all. A hundredth of this change set is still tens of rows.
    expect(new DiffRowIndex(ENDURANCE_DIFF).rowCount).toBeGreaterThan(5_000);
    expect(Math.floor(new DiffRowIndex(ENDURANCE_DIFF).rowCount / 100)).toBeGreaterThan(10);
  });
});

/**
 * How many changed lines the pathological patch carries, and how wide its worst one is.
 *
 * Two numbers rather than one shape constant, because the case is about the
 * INTERACTION between them: five thousand ordinary lines are what makes the patch a
 * realistic change set, and one line two orders of magnitude wider than the rest is
 * what made parsing it quadratic. Either alone measures nothing.
 */
const PATHOLOGICAL_PATCH_LINE_COUNT = 5_000;
const PATHOLOGICAL_LINE_TOKEN_COUNT = 1_200;

/**
 * What parsing that patch may cost, in milliseconds.
 *
 * AN ABSOLUTE HERE, WHERE THE REST OF THIS FILE USES RATIOS, because there is no
 * second measurement to take a ratio against: the defect was one line costing more
 * than every other line put together, and its "before" figure is a number this tier
 * cannot produce any more. So the budget is stated with the measurements it was set
 * between — 1.6 ms for this patch on a 2026-09-02 developer machine, against 831 ms
 * for the same patch when parsing segmented every pair. Two orders of magnitude of
 * headroom over the first and well under the second, so it fails on a regression to
 * the old behaviour and never on a loaded runner.
 */
const PATHOLOGICAL_PARSE_BUDGET_MS = 200;

describe("endurance — one pathological line inside a five-thousand-line patch", () => {
  it("parses inside its budget, and the wide row falls back rather than being compared", () => {
    const patchText = pathologicalPatchText();
    const startedAt = performance.now();
    const model = parseUnifiedPatch(
      patchText,
      { mode: "run_attributed", runId: "run-endurance" },
      { baseRef: "main", headRef: "feat/endurance" },
    );
    const parseMilliseconds = performance.now() - startedAt;

    // The subject in numbers before anything is asserted about it, so a generator
    // that quietly shrank could never pass this by measuring something smaller.
    const lines = model.files[0]?.hunks[0]?.lines ?? [];
    expect(lines).toHaveLength(PATHOLOGICAL_PATCH_LINE_COUNT);
    const widestLineLength = diffLineText(lines[0] as DiffLine).length;
    expect(widestLineLength).toBeGreaterThan(20_000);
    process.stdout.write(
      `[console-endurance] pathological parse: ${parseMilliseconds.toFixed(1)} ms, ` +
        `${String(lines.length)} lines, widest ${String(widestLineLength)} chars\n`,
    );
    expect(parseMilliseconds).toBeLessThan(PATHOLOGICAL_PARSE_BUDGET_MS);

    // And the row a reader scrolls to keeps its whole line and SAYS the comparison
    // was declined, which is the other half of the bound: the cost is not moved from
    // parse into the row, it is not paid at all.
    const cache = new IntralineSegmentCache(model);
    expect(cache.readingFor(pathologicalBodyRow(0), 0).skipped).toBe(true);
    expect(cache.computeCount).toBe(0);
  });

  it("negative control: an ordinary row in the same patch is compared", () => {
    // Without this the fallback above would pass over a register that declined every
    // pair — which would draw the note on every changed line in the console and
    // report the bound working while the highlight had simply been removed.
    const model = parseUnifiedPatch(
      pathologicalPatchText(),
      { mode: "run_attributed", runId: "run-endurance" },
      { baseRef: "main", headRef: "feat/endurance" },
    );
    const cache = new IntralineSegmentCache(model);
    const reading = cache.readingFor(pathologicalBodyRow(2), 2);
    expect(reading.skipped).toBe(false);
    expect(reading.segments.filter((segment) => segment.changed).length).toBeGreaterThan(0);
    expect(cache.computeCount).toBe(1);
  });
});

/** A body row of the pathological patch's single hunk. */
function pathologicalBodyRow(lineIndex: number): DiffLineRow {
  return { kind: "line", fileIndex: 0, hunkIndex: 0, source: "hunk-body", lineIndex };
}

/**
 * A five-thousand-line patch whose first changed pair is two very wide lines.
 *
 * Built here rather than in `diff-fixture.ts` because it is not a SHAPE the surfaces
 * render — it is one deliberately hostile input, and the fixture module's generated
 * change sets are the subjects the screenshot and layout tiers share. The wide line is
 * made of many short tokens rather than one long run of characters, because the word
 * diff's cost is quadratic in TOKENS and a single 20,000-character token would be
 * cheap for exactly the reason a real minified line is not.
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

/** Read a band of rows and report how long it took, in milliseconds. */
function timeRowReads(index: DiffRowIndex, startRowIndex: number, count: number): number {
  const startedAt = performance.now();
  for (let offset = 0; offset < count; offset += 1) {
    index.rowAt(startRowIndex + offset);
  }
  return performance.now() - startedAt;
}
