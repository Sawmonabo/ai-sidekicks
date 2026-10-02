// The renderer's claims: the mounted row count is bounded by the window, not the diff; the window
// sits at the heights rows were measured at, not estimated; and the rows say what a patch holds.
// happy-dom has no layout engine, so `tests/helpers/diff-layout-fixture.ts` supplies heights at
// the seam the library reads them from, and every case installs it.

import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DIFF_ROW_HEIGHT_PX, DIFF_WINDOW_OVERSCAN_ROWS } from "../diff-measures.js";
import { buildDiffFixture } from "@test/helpers/diff-fixture.js";
import {
  ENDURANCE_DIFF_SHAPE,
  EXTENDED_HEADER_DIFF_SHAPE,
  EXTENDED_HEADER_FIXTURE_FILES,
  SMALL_DIFF_SHAPE,
  TERMINAL_NEWLINE_FIXTURE_FILE,
} from "@test/helpers/diff-fixture-shapes.js";
import {
  DIFF_FIXTURE_VIEWPORT_HEIGHT_PX,
  DiffLayoutFixture,
  type DiffGrownRow,
} from "@test/helpers/diff-layout-fixture.js";
import { SMALL_DIFF, renderDiff, reportedRowCount } from "./DiffRenderer.test-support.js";
import { expandGap } from "../diff-row-model.js";

/** The rendered-row ceiling one window may reach: viewport rows, overscan, and a boundary row. */
const MAXIMUM_WINDOW_ROW_COUNT =
  Math.ceil(DIFF_FIXTURE_VIEWPORT_HEIGHT_PX / DIFF_ROW_HEIGHT_PX) +
  DIFF_WINDOW_OVERSCAN_ROWS * 2 +
  2;

/** The row the wrapped cases grow, and how tall a three-line wrap makes it. */
const WRAPPED_ROW: DiffGrownRow = { rowIndex: 3, heightPx: DIFF_ROW_HEIGHT_PX * 3 };

const layout = new DiffLayoutFixture();

beforeEach(() => {
  layout.install({ viewportHeightPx: DIFF_FIXTURE_VIEWPORT_HEIGHT_PX });
});

afterEach(() => {
  layout.restore();
});

describe("diff renderer — the rows", () => {
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
    // A renderer that drew every row would cost about 6,600 DOM rows here. The ceiling is derived from the bounds against a real viewport, not a round number.
    const bigDiff = buildDiffFixture(ENDURANCE_DIFF_SHAPE);
    const container = renderDiff({ model: bigDiff });
    const renderedRowCount = container.querySelectorAll(".meridian-diff__row").length;
    expect(renderedRowCount).toBeGreaterThan(0);
    expect(renderedRowCount).toBeLessThanOrEqual(MAXIMUM_WINDOW_ROW_COUNT);
  });
});

describe("diff renderer — the view controls it is handed", () => {
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

  it("leaves an unpaired deletion's head cell empty", () => {
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

/** The offset the rendered window is placed at, in CSS pixels. */
function windowOffsetPx(container: HTMLElement): number {
  const transform = container.querySelector<HTMLElement>(".meridian-diff__window")?.style.transform;
  return Number(/translateY\((?<offset>-?[\d.]+)px\)/u.exec(transform ?? "")?.groups?.["offset"]);
}

/** The index of the first row the window rendered. */
function firstRenderedRowIndex(container: HTMLElement): number {
  return Number(container.querySelector(".meridian-diff__row")?.getAttribute("data-index"));
}

/** The height the scroller holds open for the whole diff, in CSS pixels. */
function contentHeightPx(container: HTMLElement): number {
  return Number(
    container
      .querySelector<HTMLElement>(".meridian-diff__content")
      ?.style.blockSize.replace("px", ""),
  );
}

describe("diff renderer — a wrapped row and the offsets under it", () => {
  const bigDiff = buildDiffFixture(ENDURANCE_DIFF_SHAPE);
  const grownByPx = WRAPPED_ROW.heightPx - DIFF_ROW_HEIGHT_PX;

  beforeEach(() => {
    layout.install({
      viewportHeightPx: DIFF_FIXTURE_VIEWPORT_HEIGHT_PX,
      grownRow: WRAPPED_ROW,
    });
  });

  it("holds the scroller open at the height the rows measured, not the height they were estimated at", () => {
    // One row three lines tall makes the diff that much taller; a window multiplying a row
    // count by a constant would report the estimate and scroll past the end of the content.
    const container = renderDiff({ model: bigDiff });
    expect(contentHeightPx(container)).toBe(
      reportedRowCount(container) * DIFF_ROW_HEIGHT_PX + grownByPx,
    );
  });

  it("places the window below a wrapped row at the offset that row was measured at", () => {
    // Every row above the first rendered one is one row tall except the grown one, so the
    // offset is the row count times the row height plus the growth. The scroll must clear it.
    const container = renderDiff({ model: bigDiff });
    const scroller = container.querySelector<HTMLElement>(".meridian-diff");
    expect(scroller).not.toBeNull();
    scroller!.scrollTop = 4_000;
    fireEvent.scroll(scroller!);

    const firstRowIndex = firstRenderedRowIndex(container);
    expect(firstRowIndex).toBeGreaterThan(WRAPPED_ROW.rowIndex);
    expect(windowOffsetPx(container)).toBe(firstRowIndex * DIFF_ROW_HEIGHT_PX + grownByPx);
  });
});

describe("diff renderer — expansion and emptiness", () => {
  it("replaces the expanded gap with its context, leaving the diff's other gaps alone", () => {
    // Positional, not counted: the window's rows shift under the revealed lines, so a count
    // could pass for the wrong reason.
    const rowClassesAfterFirstFileHeader = (container: HTMLElement): string =>
      container.querySelectorAll(".meridian-diff__row")[1]?.className ?? "";

    expect(rowClassesAfterFirstFileHeader(renderDiff())).toContain("meridian-diff__row--gap");

    const expanded = renderDiff({
      expansion: expandGap(new Map(), 0, 0, SMALL_DIFF_SHAPE.precedingContextPerHunk),
    });
    expect(rowClassesAfterFirstFileHeader(expanded)).not.toContain("meridian-diff__row--gap");
    expect(
      expanded.querySelectorAll(".meridian-diff__row")[1]?.querySelector(".meridian-diff__side")
        ?.className,
    ).toContain("meridian-diff__side--context");
    // The diff's OTHER gaps are untouched: one control, one gap.
    expect(expanded.querySelectorAll(".meridian-diff__row--gap").length).toBeGreaterThan(0);
  });

  it("says nothing to review when a read holds no changed line", () => {
    // `empty`, not `not-checked`: a diff was read here and holds no changed line.
    const container = renderDiff({ model: { ...SMALL_DIFF, files: [] } });
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
    expect(container.querySelector(".meridian-nothing--not-checked")).toBeNull();
  });
});

describe("diff renderer — the file header carries what the extended headers said", () => {
  const EXTENDED_HEADER_DIFF = buildDiffFixture(EXTENDED_HEADER_DIFF_SHAPE);

  /**
   * The file-header row for one path, narrowed to that file. Narrowed rather than scrolled to:
   * a header-only file has no hunks, so it is the last row and the window need not reach it.
   */
  function fileHeaderTextFor(path: string): string {
    const container = renderDiff({ model: EXTENDED_HEADER_DIFF, shownFilePath: path });
    const row = container.querySelector(".meridian-diff__row--file");
    if (row === null) {
      throw new Error(`the renderer drew no file header for ${path}`);
    }
    return row.textContent ?? "";
  }

  it("names the path a rename came from, which is the only row that file has", () => {
    const { renamed } = EXTENDED_HEADER_FIXTURE_FILES;
    const headerText = fileHeaderTextFor(renamed.to);
    expect(headerText).toContain(renamed.to);
    expect(headerText).toContain(`renamed from ${renamed.from}`);
  });

  it("tells a copy from a rename, because the source still exists", () => {
    const { copied } = EXTENDED_HEADER_FIXTURE_FILES;
    expect(fileHeaderTextFor(copied.to)).toContain(`copied from ${copied.from}`);
  });

  it("renders a mode change as both modes, so which direction is legible", () => {
    const { modeChanged } = EXTENDED_HEADER_FIXTURE_FILES;
    expect(fileHeaderTextFor(modeChanged.path)).toContain(
      `mode ${modeChanged.from} → ${modeChanged.to}`,
    );
  });

  it("marks a binary file, whose change no unified patch can show", () => {
    expect(fileHeaderTextFor(EXTENDED_HEADER_FIXTURE_FILES.binary.path)).toContain(
      "binary file changed",
    );
  });
});

describe("diff renderer — the line that ends the file without a newline", () => {
  const TERMINAL_NEWLINE_DIFF = buildDiffFixture(EXTENDED_HEADER_DIFF_SHAPE);

  /** The file whose two changed rows carry the same text, narrowed to itself. */
  function terminalNewlineRows(viewMode: "unified" | "split"): readonly HTMLElement[] {
    const container = renderDiff({
      model: TERMINAL_NEWLINE_DIFF,
      shownFilePath: TERMINAL_NEWLINE_FIXTURE_FILE.path,
      viewMode,
    });
    return [...container.querySelectorAll<HTMLElement>(".meridian-diff__row--line")];
  }

  it("says which of two identical lines is the one with no terminator", () => {
    // The deletion and insertion are the same characters, so without the annotation the pane
    // draws two rows a reader cannot tell apart.
    const rows = terminalNewlineRows("unified");
    const annotated = rows.filter(
      (row) => row.querySelector(".meridian-diff__no-newline") !== null,
    );

    expect(annotated).toHaveLength(1);
    expect(annotated[0]?.textContent).toContain("No newline at end of file");
    expect(annotated[0]?.textContent).toContain(TERMINAL_NEWLINE_FIXTURE_FILE.lastLine);
  });

  it("puts the annotation on the side that carries it in split view", () => {
    // A paired row holds a deletion and an insertion and only one lacks a terminator, so a
    // marker on the row rather than the cell would claim it of both.
    const [pairedRow] = terminalNewlineRows("split").filter(
      (row) => row.querySelector(".meridian-diff__no-newline") !== null,
    );
    const headCell = pairedRow?.querySelector(".meridian-diff__side--head");
    const baseCell = pairedRow?.querySelector(".meridian-diff__side--base");

    expect(headCell?.querySelector(".meridian-diff__no-newline")).not.toBeNull();
    expect(baseCell?.querySelector(".meridian-diff__no-newline")).toBeNull();
  });
});
