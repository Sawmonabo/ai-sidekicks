// The renderer's claims. The three that matter most: the mounted row count is bounded by the
// window, not the diff; the window sits at the heights rows were measured at, not estimated
// (cases in the geometry suite); and no line kind is painted amber or red (the two-hue rule).
// happy-dom has no layout engine, so `tests/helpers/diff-layout-fixture.ts` supplies heights
// at the seam the library reads them from, and every case installs it.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DIFF_ROW_HEIGHT_PX, DIFF_WINDOW_OVERSCAN_ROWS } from "../diff-measures.js";
import { buildDiffFixture } from "@test/helpers/diff-fixture.js";
import { ENDURANCE_DIFF_SHAPE } from "@test/helpers/diff-fixture-shapes.js";
import {
  DIFF_FIXTURE_VIEWPORT_HEIGHT_PX,
  DiffLayoutFixture,
} from "@test/helpers/diff-layout-fixture.js";
import { SMALL_DIFF, renderDiff, reportedRowCount } from "./diff-renderer.test-support.js";

/** The rendered-row ceiling one window may reach: viewport rows, overscan, and a boundary row. */
const MAXIMUM_WINDOW_ROW_COUNT =
  Math.ceil(DIFF_FIXTURE_VIEWPORT_HEIGHT_PX / DIFF_ROW_HEIGHT_PX) +
  DIFF_WINDOW_OVERSCAN_ROWS * 2 +
  2;

const layout = new DiffLayoutFixture();

beforeEach(() => {
  layout.install({ viewportHeightPx: DIFF_FIXTURE_VIEWPORT_HEIGHT_PX });
});

afterEach(() => {
  layout.restore();
});

describe("diff renderer — the rows", () => {
  it("names itself as a table and reports the whole diff's row count", () => {
    const container = renderDiff();
    const scroller = container.querySelector(".meridian-diff");
    expect(scroller?.getAttribute("aria-label")).toBe("Diff, main to feat/rate-limit-wiring");
    // The count is the diff's, not the window's: a virtualized list reporting its rendered
    // count would tell a screen reader the diff is fifteen rows long.
    expect(scroller?.getAttribute("aria-rowcount")).toBe("22");
  });

  it("draws the file header, the gap, the hunk header, and the lines", () => {
    const container = renderDiff();
    expect(container.querySelector(".meridian-diff__row--file")?.textContent).toContain(
      "packages/runtime-daemon/src/module-00.ts",
    );
    expect(container.querySelector(".meridian-diff__row--gap")?.textContent).toContain(
      "Expand 4 hidden lines",
    );
    // The header the patch declared, per side: a three-line hunk of one context,
    // one deletion, and one insertion is two lines on each side, not three on both.
    expect(container.querySelector(".meridian-diff__row--hunk")?.textContent).toContain(
      "@@ -1,2 +1,2 @@",
    );
    expect(container.querySelectorAll(".meridian-diff__row--line").length).toBeGreaterThan(0);
  });

  it("renders only a window of a five-thousand-line change set", () => {
    // A renderer that drew every row would pass every other case and cost about 6,600 DOM rows
    // here. The ceiling is derived from the bounds against a real viewport, not a round number.
    const bigDiff = buildDiffFixture(ENDURANCE_DIFF_SHAPE);
    const container = renderDiff({ model: bigDiff });
    const renderedRowCount = container.querySelectorAll(".meridian-diff__row").length;
    expect(renderedRowCount).toBeGreaterThan(0);
    expect(renderedRowCount).toBeLessThanOrEqual(MAXIMUM_WINDOW_ROW_COUNT);
  });

  it("negative control: the big diff really is big, so the bound above is not vacuous", () => {
    const bigDiff = buildDiffFixture(ENDURANCE_DIFF_SHAPE);
    const container = renderDiff({ model: bigDiff });
    const reported = container.querySelector(".meridian-diff")?.getAttribute("aria-rowcount");
    expect(Number(reported)).toBeGreaterThan(5000);
  });
});

describe("diff renderer — the two-hue rule", () => {
  it("paints insert and delete with ground and rule, never with a hue token", () => {
    const container = renderDiff();
    // The modifier rides the cell so a split row can paint its two sides in two kinds; in
    // unified the row's one cell fills it.
    const insertCell = container.querySelector(".meridian-diff__side--insert");
    const deleteCell = container.querySelector(".meridian-diff__side--delete");
    expect(insertCell).not.toBeNull();
    expect(deleteCell).not.toBeNull();
    // The classes are distinct; the sheet paints them as two ground weights and two rule styles.
    expect(insertCell?.className).not.toBe(deleteCell?.className);
  });

  it("negative control: no row carries the kind modifier the cell now owns", () => {
    // Negative control: a renderer painting the kind in both places would give a paired split
    // row a whole-width ground in one kind.
    const container = renderDiff();
    for (const row of container.querySelectorAll(".meridian-diff__row")) {
      expect(row.className).not.toContain("meridian-diff__row--insert");
      expect(row.className).not.toContain("meridian-diff__row--delete");
      expect(row.className).not.toContain("meridian-diff__row--context");
    }
  });

  it("negative control: no diff row reaches for amber or red", () => {
    // Amber means a person is needed and red means something failed; a deleted line is neither.
    const container = renderDiff();
    for (const row of container.querySelectorAll(".meridian-diff__row")) {
      expect(row.className).not.toContain("amber");
      expect(row.className).not.toContain("failure");
      expect(row.className).not.toContain("--red");
    }
  });
});

describe("diff renderer — the view controls it is handed", () => {
  it("renders two sides in split view and one in unified", () => {
    expect(
      renderDiff({ viewMode: "split" }).querySelectorAll(".meridian-diff__side--base").length,
    ).toBeGreaterThan(0);
    expect(
      renderDiff({ viewMode: "unified" }).querySelectorAll(".meridian-diff__side--base").length,
    ).toBe(0);
  });

  it("puts a modified line's old text and new text side by side in ONE split row", () => {
    // The fixture spells a modified line as a deletion followed by an insertion, and the
    // flattening pairs them, so the two cells of one row carry different text.
    const container = renderDiff({ viewMode: "split" });
    const pairedRow = [...container.querySelectorAll(".meridian-diff__row--line")].find(
      (row) => row.querySelector(".meridian-diff__side--delete") !== null,
    );
    expect(pairedRow).toBeDefined();
    expect(
      pairedRow?.querySelector(".meridian-diff__side--base .meridian-diff__code")?.textContent,
    ).toContain("previousBudget");
    expect(
      pairedRow?.querySelector(".meridian-diff__side--head .meridian-diff__code")?.textContent,
    ).toContain("nextBudget");
  });

  it("negative control: the pairing is one row, so split reports fewer rows than unified", () => {
    // Negative control: new text painted into the deletion row's head cell while the insertion
    // stays a second row below would pass above.
    expect(reportedRowCount(renderDiff({ viewMode: "split" }))).toBeLessThan(
      reportedRowCount(renderDiff({ viewMode: "unified" })),
    );
  });

  it("negative control: an unpaired deletion still leaves its head cell empty", () => {
    // Pairing must not become "show the line on both sides", which reads a deletion as a
    // modification of itself.
    const deletionOnly = {
      ...SMALL_DIFF,
      files: [
        {
          path: "packages/contracts/src/budget.ts",
          hunks: [
            {
              header: "@@ -1,1 +1,0 @@",
              precedingContext: [],
              lines: [
                {
                  kind: "delete" as const,
                  baseLineNumber: 1,
                  segments: [{ text: "const removed = 1;", changed: false }],
                },
              ],
            },
          ],
        },
      ],
    };
    const container = renderDiff({ model: deletionOnly, viewMode: "split" });
    const row = container.querySelector(".meridian-diff__row--line");
    expect(row?.querySelector(".meridian-diff__side--base .meridian-diff__code")?.textContent).toBe(
      "const removed = 1;",
    );
    expect(row?.querySelector(".meridian-diff__side--head .meridian-diff__code")).toBeNull();
  });

  it("marks the changed segment of a modified line pair", () => {
    // A modified pair, not a hand-segmented line: segmentation is derived per rendered row, so
    // pre-split segments would assert a shape the renderer never reads.
    const modifiedPairDiff = {
      ...SMALL_DIFF,
      files: [
        {
          path: "packages/contracts/src/spacing.ts",
          hunks: [
            {
              header: "@@ -1,1 +1,1 @@",
              precedingContext: [],
              lines: [
                {
                  kind: "delete" as const,
                  baseLineNumber: 1,
                  segments: [{ text: "const value = 1;", changed: false }],
                },
                {
                  kind: "insert" as const,
                  headLineNumber: 1,
                  segments: [{ text: "const value   = 1;", changed: false }],
                },
              ],
            },
          ],
        },
      ],
    };
    const container = renderDiff({ model: modifiedPairDiff });
    // Two: one per side of one alignment, both of them the run of spaces.
    expect(container.querySelectorAll(".meridian-diff__segment--changed").length).toBe(2);
    expect(
      [...container.querySelectorAll(".meridian-diff__code")].map((code) => code.textContent),
    ).toStrictEqual(["const value = 1;", "const value   = 1;"]);
  });
});
