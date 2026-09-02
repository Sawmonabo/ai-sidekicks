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
// three things the unit tier cannot:
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

import process from "node:process";

import { describe, expect, it } from "vitest";

import {
  ENDURANCE_DIFF_SHAPE,
  SINGLE_LARGE_HUNK_DIFF_SHAPE,
  buildDiffFixture,
  fixtureChangedLineCount,
} from "../../../src/renderer/src/console/panes/diff/diff-fixture.js";
import {
  DiffRowIndex,
  diffGapKey,
  expandGap,
  type DiffGapExpansion,
} from "../../../src/renderer/src/console/panes/diff/hunk-virtualization.js";

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

/** Read a band of rows and report how long it took, in milliseconds. */
function timeRowReads(index: DiffRowIndex, startRowIndex: number, count: number): number {
  const startedAt = performance.now();
  for (let offset = 0; offset < count; offset += 1) {
    index.rowAt(startRowIndex + offset);
  }
  return performance.now() - startedAt;
}
