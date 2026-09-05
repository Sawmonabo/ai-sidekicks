// Gap expansion with predecessor retention: what a second press may never take back.
//
// Beside the value it is about, on the same seam `diff-row-model.ts` cuts: the
// expansion is a value the pane holds and replaces, and its rule — monotonic growth,
// clamped, never mutating — is checkable without an index at all. The two cases that
// DO build one build it to show that the row count and the gap row follow the value,
// which is the claim the pane rests on.

import { describe, expect, it } from "vitest";

import { DIFF_GAP_EXPANSION_LINE_COUNT } from "./diff-bounds.js";
import { buildDiffFixture } from "./diff-fixture.js";
import { SMALL_DIFF_SHAPE } from "./diff-fixture-shapes.js";
import { diffGapKey, expandGap } from "./diff-row-model.js";
import { DiffRowIndex } from "./hunk-virtualization.js";

const SMALL_DIFF = buildDiffFixture(SMALL_DIFF_SHAPE);

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
