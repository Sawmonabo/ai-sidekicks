// Tier: endurance — `Spec-023 §Console Test Tiers`.
//
// `steady-state.test.ts` beside this file measures the console held open for a
// working day. This one measures the other endurance case a desktop console has:
// one surface handed a body far larger than anything it is scrolled through, held
// open, and worked. A forty-file, five-thousand-line change set is the shape
// §10.6 is written against, and every property this file asserts is one that
// holds at ten rows and quietly stops holding at five thousand.
//
// WHY THIS RUNS IN THE NODE PROJECT AND OPENS NO ELECTRON WINDOW
//
// The subject is the diff's flattening and its window — `hunk-virtualization.ts`
// — which is arithmetic over a model and touches no DOM. That separation is
// deliberate in the module and this file is what cashes it: the endurance claims
// about a five-thousand-line diff are checkable in milliseconds, deterministically,
// on any runner, with no bundle to build and no window to launch. The rendering
// half is checked in `DiffRenderer.test.tsx`, which asserts the DOM row count
// stays bounded — that is the other side of the same claim and it belongs beside
// the component.
//
// So this tier is not "the same cases again with a bigger fixture". It asserts
// three things the unit tier cannot:
//
//   1. COST DOES NOT SCALE WITH THE DIFF. Flattening is paid once per expansion,
//      and a scroll — the thing a person does thousands of times — costs a window
//      computation whose work is bounded by the viewport. A `rowAt` that walked
//      from the top would satisfy every unit case and make a scroll to row 5,000
//      cost 5,000 steps.
//   2. SUSTAINED WORK RETAINS NOTHING. Ten thousand scroll positions and a
//      hundred gap expansions leave no growing structure behind, which is the
//      leak class a fast tier cannot see.
//   3. EVERY ROW IS ADDRESSABLE. Not a sample — every one of the ~6,600 rows
//      resolves to a row value, and every line row resolves to a line. An
//      off-by-one in the per-file walk shows up as one unreachable row somewhere
//      in the middle, which no spot check finds.

import process from "node:process";

import { describe, expect, it } from "vitest";

import {
  DIFF_ROW_HEIGHT_PX,
  DIFF_WINDOW_OVERSCAN_ROWS,
} from "../../../src/renderer/src/console/panes/diff/diff-bounds.js";
import {
  ENDURANCE_DIFF_SHAPE,
  buildDiffFixture,
  fixtureChangedLineCount,
} from "../../../src/renderer/src/console/panes/diff/diff-fixture.js";
import {
  DiffRowIndex,
  diffGapKey,
  expandGap,
  type DiffGapExpansion,
} from "../../../src/renderer/src/console/panes/diff/hunk-virtualization.js";

/** The viewport the run scrolls through, in CSS pixels. A laptop-class pane. */
const ENDURANCE_VIEWPORT_HEIGHT_PX = 800;

/**
 * Scroll positions the run visits.
 *
 * Large enough that a per-scroll cost linear in the change set would take the run
 * from milliseconds to minutes, which is what makes the timing assertion below a
 * real bound rather than a formality.
 */
const SCROLL_SAMPLE_COUNT = 10_000;

/**
 * The rendered-row ceiling one window may reach.
 *
 * Derived from the bounds rather than picked: the viewport's own rows plus
 * overscan on both sides, plus the boundary row. A window that returned more than
 * this is a virtualizer that is not virtualizing.
 */
const MAXIMUM_WINDOW_ROW_COUNT =
  Math.ceil(ENDURANCE_VIEWPORT_HEIGHT_PX / DIFF_ROW_HEIGHT_PX) + DIFF_WINDOW_OVERSCAN_ROWS * 2 + 2;

const ENDURANCE_DIFF = buildDiffFixture(ENDURANCE_DIFF_SHAPE);

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

  it("keeps a window bounded by the viewport at every scroll position in the diff", () => {
    const index = new DiffRowIndex(ENDURANCE_DIFF);
    const totalHeightPx = index.rowCount * DIFF_ROW_HEIGHT_PX;
    for (let sample = 0; sample < SCROLL_SAMPLE_COUNT; sample += 1) {
      const scrollTopPx = Math.floor((totalHeightPx * sample) / SCROLL_SAMPLE_COUNT);
      const rowWindow = index.windowFor({
        scrollTopPx,
        viewportHeightPx: ENDURANCE_VIEWPORT_HEIGHT_PX,
      });
      const windowRowCount = rowWindow.endIndex - rowWindow.startIndex;
      if (windowRowCount > MAXIMUM_WINDOW_ROW_COUNT) {
        throw new Error(
          `window at ${String(scrollTopPx)} px holds ${String(windowRowCount)} rows, past the ${String(MAXIMUM_WINDOW_ROW_COUNT)}-row ceiling`,
        );
      }
      // The spacer and the content box together are what the scrollbar reports;
      // if either drifted, the diff would scroll to a position that shows nothing.
      expect(rowWindow.leadingSpacerPx).toBe(rowWindow.startIndex * DIFF_ROW_HEIGHT_PX);
      expect(rowWindow.totalHeightPx).toBe(totalHeightPx);
    }
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

  it("negative control: the ceiling is one a naive renderer would breach", () => {
    // Without this the window bound above would pass over a diff whose row count
    // was smaller than the ceiling — which is to say, over no virtualization at
    // all.
    expect(new DiffRowIndex(ENDURANCE_DIFF).rowCount).toBeGreaterThan(
      MAXIMUM_WINDOW_ROW_COUNT * 50,
    );
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
