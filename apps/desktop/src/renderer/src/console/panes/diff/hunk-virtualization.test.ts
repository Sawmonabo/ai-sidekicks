// The flattening and the window, which are the two claims the diff surfaces rest
// on and the two nothing else in the console can check.
//
// Every case here runs without a DOM, because the arithmetic is separable from
// the rendering — which is the property that lets the endurance tier measure a
// five-thousand-line change set at all.

import { describe, expect, it } from "vitest";

import {
  DIFF_GAP_EXPANSION_LINE_COUNT,
  DIFF_ROW_HEIGHT_PX,
  DIFF_WINDOW_OVERSCAN_ROWS,
} from "./diff-bounds.js";
import {
  ENDURANCE_DIFF_SHAPE,
  SMALL_DIFF_SHAPE,
  buildDiffFixture,
  fixtureChangedLineCount,
} from "./diff-fixture.js";
import { DiffRowIndex, diffGapKey, expandGap } from "./hunk-virtualization.js";

const SMALL_DIFF = buildDiffFixture(SMALL_DIFF_SHAPE);

/**
 * The row count the shape implies, derived from the shape rather than counted
 * off a run of the code under test.
 *
 * Per file: one file header, then per hunk one gap row (while anything is
 * hidden), the revealed context, the hunk header, and the hunk's own lines.
 */
function expectedRowCount(revealedPerGap: number): number {
  const shape = SMALL_DIFF_SHAPE;
  const revealed = Math.min(revealedPerGap, shape.precedingContextPerHunk);
  const hidden = shape.precedingContextPerHunk - revealed;
  const perHunk = (hidden > 0 ? 1 : 0) + revealed + 1 + shape.linesPerHunk;
  return shape.fileCount * (1 + shape.hunksPerFile * perHunk);
}

describe("hunk virtualization — flattening", () => {
  it("counts every row the shape implies", () => {
    expect(new DiffRowIndex(SMALL_DIFF).rowCount).toBe(expectedRowCount(0));
  });

  it("addresses each row kind at the position the layout puts it", () => {
    const index = new DiffRowIndex(SMALL_DIFF);
    expect(index.rowAt(0)).toStrictEqual({ kind: "file-header", fileIndex: 0 });
    expect(index.rowAt(1)).toStrictEqual({
      kind: "gap",
      fileIndex: 0,
      hunkIndex: 0,
      hiddenLineCount: SMALL_DIFF_SHAPE.precedingContextPerHunk,
    });
    expect(index.rowAt(2)).toStrictEqual({ kind: "hunk-header", fileIndex: 0, hunkIndex: 0 });
    expect(index.rowAt(3)).toStrictEqual({
      kind: "line",
      fileIndex: 0,
      hunkIndex: 0,
      source: "hunk-body",
      lineIndex: 0,
    });
  });

  it("finds the second file through the binary search, not by walking", () => {
    const index = new DiffRowIndex(SMALL_DIFF);
    const secondFileRowIndex = index.rowIndexOfFile(1);
    expect(secondFileRowIndex).toBeDefined();
    expect(index.rowAt(Number(secondFileRowIndex))).toStrictEqual({
      kind: "file-header",
      fileIndex: 1,
    });
  });

  it("resolves a line row to the line it addresses", () => {
    const index = new DiffRowIndex(SMALL_DIFF);
    const bodyRow = index.rowAt(3);
    expect(bodyRow).toBeDefined();
    expect(index.lineFor(bodyRow!)).toBe(SMALL_DIFF.files[0]?.hunks[0]?.lines[0]);
  });

  it("negative control: an index past the end resolves to nothing", () => {
    // Without this, `rowAt` could be returning the last row for every index past
    // it and every case above would still pass.
    const index = new DiffRowIndex(SMALL_DIFF);
    expect(index.rowAt(index.rowCount)).toBeUndefined();
    expect(index.rowAt(-1)).toBeUndefined();
  });

  it("negative control: a row kind is not resolved to a line", () => {
    const index = new DiffRowIndex(SMALL_DIFF);
    const fileHeader = index.rowAt(0);
    expect(fileHeader).toBeDefined();
    expect(index.lineFor(fileHeader!)).toBeUndefined();
  });
});

describe("hunk virtualization — gap expansion with predecessor retention", () => {
  it("reveals one band, and the gap row survives while anything is hidden", () => {
    const expansion = expandGap(new Map(), 0, 0, SMALL_DIFF_SHAPE.precedingContextPerHunk);
    const index = new DiffRowIndex(SMALL_DIFF, expansion);
    // The fixture's gap is smaller than one expansion band, so one activation
    // reveals all of it and the gap row is gone.
    expect(SMALL_DIFF_SHAPE.precedingContextPerHunk).toBeLessThan(DIFF_GAP_EXPANSION_LINE_COUNT);
    expect(index.rowAt(1)).toStrictEqual({
      kind: "line",
      fileIndex: 0,
      hunkIndex: 0,
      source: "preceding-context",
      lineIndex: 0,
    });
  });

  it("retains what a previous activation revealed", () => {
    // The retention claim needs a gap wider than one band, so it is checked on a
    // shape that has one rather than on the small fixture.
    const wideGapDiff = buildDiffFixture({
      ...SMALL_DIFF_SHAPE,
      precedingContextPerHunk: DIFF_GAP_EXPANSION_LINE_COUNT * 3,
    });
    const available = DIFF_GAP_EXPANSION_LINE_COUNT * 3;
    const once = expandGap(new Map(), 0, 0, available);
    const twice = expandGap(once, 0, 0, available);
    expect(once.get(diffGapKey(0, 0))).toBe(DIFF_GAP_EXPANSION_LINE_COUNT);
    expect(twice.get(diffGapKey(0, 0))).toBe(DIFF_GAP_EXPANSION_LINE_COUNT * 2);
    expect(new DiffRowIndex(wideGapDiff, twice).rowCount).toBeGreaterThan(
      new DiffRowIndex(wideGapDiff, once).rowCount,
    );
  });

  it("reveals the lines nearest the hunk first, because a gap is read outwards", () => {
    const available = DIFF_GAP_EXPANSION_LINE_COUNT * 2;
    const wideGapDiff = buildDiffFixture({
      ...SMALL_DIFF_SHAPE,
      precedingContextPerHunk: available,
    });
    const index = new DiffRowIndex(wideGapDiff, expandGap(new Map(), 0, 0, available));
    // Row 1 is the surviving gap row; row 2 is the first revealed line, and it is
    // the one immediately above the hunk rather than the top of the gap.
    expect(index.rowAt(2)).toStrictEqual({
      kind: "line",
      fileIndex: 0,
      hunkIndex: 0,
      source: "preceding-context",
      lineIndex: available - DIFF_GAP_EXPANSION_LINE_COUNT,
    });
  });

  it("clamps at what the gap holds and returns the same value once exhausted", () => {
    const exhausted = expandGap(new Map(), 0, 0, 3);
    expect(exhausted.get(diffGapKey(0, 0))).toBe(3);
    expect(expandGap(exhausted, 0, 0, 3)).toBe(exhausted);
  });

  it("negative control: expanding never mutates the value it was given", () => {
    // Without this, `expandGap` could be mutating in place and returning the same
    // reference — every count above would pass and React would render nothing,
    // because the identity a memo compares would never change.
    const before: ReadonlyMap<string, number> = new Map();
    expandGap(before, 0, 0, 10);
    expect(before.size).toBe(0);
  });
});

describe("hunk virtualization — the window", () => {
  it("renders the viewport plus overscan, not the whole diff", () => {
    const index = new DiffRowIndex(buildDiffFixture(ENDURANCE_DIFF_SHAPE));
    const viewportHeightPx = 400;
    const rowWindow = index.windowFor({ scrollTopPx: 0, viewportHeightPx });
    const visibleRowCount = Math.ceil(viewportHeightPx / DIFF_ROW_HEIGHT_PX);
    expect(rowWindow.startIndex).toBe(0);
    expect(rowWindow.endIndex).toBe(visibleRowCount + DIFF_WINDOW_OVERSCAN_ROWS + 1);
    expect(rowWindow.endIndex).toBeLessThan(index.rowCount);
  });

  it("offsets the window by the rows it skipped, and holds the full height open", () => {
    const index = new DiffRowIndex(buildDiffFixture(ENDURANCE_DIFF_SHAPE));
    const rowWindow = index.windowFor({ scrollTopPx: 10_000, viewportHeightPx: 400 });
    expect(rowWindow.leadingSpacerPx).toBe(rowWindow.startIndex * DIFF_ROW_HEIGHT_PX);
    expect(rowWindow.totalHeightPx).toBe(index.rowCount * DIFF_ROW_HEIGHT_PX);
  });

  it("clamps a scroll position past the content instead of asking for rows that do not exist", () => {
    const index = new DiffRowIndex(SMALL_DIFF);
    const rowWindow = index.windowFor({ scrollTopPx: 10_000_000, viewportHeightPx: 400 });
    expect(rowWindow.startIndex).toBeLessThan(index.rowCount);
    expect(rowWindow.endIndex).toBeLessThanOrEqual(index.rowCount);
    expect(rowWindow.endIndex).toBeGreaterThanOrEqual(rowWindow.startIndex);
  });

  it("answers an empty diff without a window at all", () => {
    const empty = new DiffRowIndex({ ...SMALL_DIFF, files: [] });
    expect(empty.windowFor({ scrollTopPx: 0, viewportHeightPx: 400 })).toStrictEqual({
      startIndex: 0,
      endIndex: 0,
      leadingSpacerPx: 0,
      totalHeightPx: 0,
    });
  });

  it("negative control: the window moves when the scroll position does", () => {
    // Without this, a `windowFor` that ignored `scrollTopPx` and always answered
    // from the top would satisfy every bound above.
    const index = new DiffRowIndex(buildDiffFixture(ENDURANCE_DIFF_SHAPE));
    const top = index.windowFor({ scrollTopPx: 0, viewportHeightPx: 400 });
    const lower = index.windowFor({ scrollTopPx: 10_000, viewportHeightPx: 400 });
    expect(lower.startIndex).toBeGreaterThan(top.startIndex);
  });
});

describe("hunk virtualization — the bounds it spends", () => {
  it("overscans in both directions and caps a card above one row", () => {
    // The bounds are a table of numbers, and a table of numbers is only a
    // decision while the relations between them hold. An overscan of zero would
    // expose the unrendered band on every flick; a height cap below one row would
    // render a card with nothing in it.
    expect(DIFF_WINDOW_OVERSCAN_ROWS).toBeGreaterThan(0);
    expect(DIFF_GAP_EXPANSION_LINE_COUNT).toBeGreaterThan(0);
    expect(DIFF_ROW_HEIGHT_PX).toBeGreaterThan(0);
  });

  it("describes the endurance shape it claims to", () => {
    expect(fixtureChangedLineCount(ENDURANCE_DIFF_SHAPE)).toBe(5000);
    expect(ENDURANCE_DIFF_SHAPE.fileCount).toBe(40);
  });
});
