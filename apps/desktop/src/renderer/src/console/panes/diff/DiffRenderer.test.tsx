// The renderer's claims, and the three it would be worst to get wrong.
//
// The ordinary ones are that the rows arrive, that both layouts draw what each
// layout should, and that a long line is never clipped. The three that matter
// more are the ones a reviewer cannot see by looking at a screenshot: that the
// row count on screen is bounded by the WINDOW and not by the diff, which is the
// only reason a five-thousand-line change set is openable at all; that with wrap
// ON the window is placed at the heights the rows were MEASURED at rather than at
// the height they were estimated at, which is the case the sheet's
// `block-size: auto` creates and a fixed-height window silently gets wrong; and
// that no line kind is painted amber or red, which is the two-hue rule and is
// exactly the rule a diff renderer is most likely to break.
//
// HOW A ROW GETS A HEIGHT HERE. happy-dom has no layout engine, so every box it
// reports is zero and a window measured against one would be measured against
// nothing. `diff-layout-fixture.ts` supplies the heights at the seam the library
// reads them from, and every case here installs it. Nothing about the window is
// reimplemented: the library computes it from the numbers a browser would have
// given it.

import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DIFF_ROW_HEIGHT_PX, DIFF_WINDOW_OVERSCAN_ROWS } from "./diff-bounds.js";
import {
  ENDURANCE_DIFF_SHAPE,
  EXTENDED_HEADER_DIFF_SHAPE,
  EXTENDED_HEADER_FIXTURE_FILES,
  SMALL_DIFF_SHAPE,
  buildDiffFixture,
} from "./diff-fixture.js";
import {
  DIFF_FIXTURE_VIEWPORT_HEIGHT_PX,
  DiffLayoutFixture,
  type DiffGrownRow,
} from "./diff-layout-fixture.js";
import { DiffRenderer } from "./DiffRenderer.js";
import { expandGap, type DiffGapExpansion } from "./hunk-virtualization.js";

const SMALL_DIFF = buildDiffFixture(SMALL_DIFF_SHAPE);
const NO_EXPANSION: DiffGapExpansion = new Map();

/**
 * The rendered-row ceiling one window may reach.
 *
 * Derived from the bounds rather than picked: the viewport's own rows plus
 * overscan on both sides, plus the boundary row. A window that returned more than
 * this is a virtualizer that is not virtualizing.
 */
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

/** The offset the rendered window is placed at, in CSS pixels. */
function windowOffsetPx(container: HTMLElement): number {
  const transform = container.querySelector<HTMLElement>(".meridian-diff__window")?.style.transform;
  return Number(/translateY\((?<offset>-?[\d.]+)px\)/u.exec(transform ?? "")?.groups?.["offset"]);
}

/** The index of the first row the window rendered. */
function firstRenderedRowIndex(container: HTMLElement): number {
  return Number(container.querySelector(".meridian-diff__row")?.getAttribute("data-index"));
}

/** The row count the scroller reports for the whole diff. */
function reportedRowCount(container: HTMLElement): number {
  return Number(container.querySelector(".meridian-diff")?.getAttribute("aria-rowcount"));
}

/** The height the scroller holds open for the whole diff, in CSS pixels. */
function contentHeightPx(container: HTMLElement): number {
  return Number(
    container
      .querySelector<HTMLElement>(".meridian-diff__content")
      ?.style.blockSize.replace("px", ""),
  );
}

/** The renderer's props for a case, with whatever that case cares about replaced. */
function diffRendererProps(
  overrides: Partial<React.ComponentProps<typeof DiffRenderer>> = {},
): React.ComponentProps<typeof DiffRenderer> {
  return {
    model: SMALL_DIFF,
    viewMode: "unified",
    showAttributionMarks: true,
    wrapLongLines: false,
    showWhitespaceChanges: true,
    expansion: NO_EXPANSION,
    onExpandGap: () => undefined,
    label: "Diff, main to feat/rate-limit-wiring",
    ...overrides,
  };
}

function renderDiff(
  overrides: Partial<React.ComponentProps<typeof DiffRenderer>> = {},
): HTMLElement {
  return render(<DiffRenderer {...diffRendererProps(overrides)} />).container;
}

describe("diff renderer — the rows", () => {
  it("names itself as a table and reports the whole diff's row count", () => {
    const container = renderDiff();
    const scroller = container.querySelector(".meridian-diff");
    expect(scroller?.getAttribute("aria-label")).toBe("Diff, main to feat/rate-limit-wiring");
    // The count is the DIFF's, not the window's — a virtualized list that
    // reported its rendered count would tell a screen reader the diff is
    // fifteen rows long.
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
    // The claim the whole module exists for. A renderer that drew every row would
    // pass every other case in this file and cost about 6,600 DOM rows here. The
    // ceiling is derived from the bounds against a real viewport height, so it
    // holds the window to the pane it is drawn in rather than to a round number.
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
    // The modifier rides the CELL, so a split row can paint its two sides in two
    // kinds. In unified the row's one cell fills it, so the painted ground is the
    // same rectangle it always was.
    const insertCell = container.querySelector(".meridian-diff__side--insert");
    const deleteCell = container.querySelector(".meridian-diff__side--delete");
    expect(insertCell).not.toBeNull();
    expect(deleteCell).not.toBeNull();
    // The classes are the whole signal, and they are distinct — which is what the
    // sheet then paints as two ground weights and two rule styles.
    expect(insertCell?.className).not.toBe(deleteCell?.className);
  });

  it("negative control: no row carries the kind modifier the cell now owns", () => {
    // Without this, the case above would pass over a renderer that painted the
    // kind in both places — and a paired split row would then be a whole-width
    // ground in one of its two kinds.
    const container = renderDiff();
    for (const row of container.querySelectorAll(".meridian-diff__row")) {
      expect(row.className).not.toContain("meridian-diff__row--insert");
      expect(row.className).not.toContain("meridian-diff__row--delete");
      expect(row.className).not.toContain("meridian-diff__row--context");
    }
  });

  it("negative control: no diff row reaches for amber or red", () => {
    // Amber means a person is needed and red means something failed. A deleted
    // line is neither, and this is the case that fails the day somebody reaches
    // for the familiar colours.
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
    // The one thing split view exists to do. The fixture's hunks spell a modified
    // line the way a unified patch does — a deletion immediately followed by an
    // insertion — and the flattening pairs them, so the two cells of one row
    // carry different text.
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
    // Without this the case above would pass over a renderer that painted the new
    // text into the deletion row's head cell while still emitting the insertion
    // as a second row below it — two rows claiming the same change.
    expect(reportedRowCount(renderDiff({ viewMode: "split" }))).toBeLessThan(
      reportedRowCount(renderDiff({ viewMode: "unified" })),
    );
  });

  it("negative control: an unpaired deletion still leaves its head cell empty", () => {
    // Pairing must not become "show the line on both sides", which is the bug
    // that makes a deletion read as a modification of itself.
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

  it("marks the intraline change, and stops marking a whitespace-only one on request", () => {
    // A modified PAIR rather than a hand-segmented line: the segmentation is
    // derived per rendered row now, so a model carrying pre-split segments would
    // assert against a shape the renderer never reads.
    const whitespaceOnlyDiff = {
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
    const shown = renderDiff({ model: whitespaceOnlyDiff, showWhitespaceChanges: true });
    // Two: one per side of one alignment, both of them the run of spaces.
    expect(shown.querySelectorAll(".meridian-diff__segment--changed").length).toBe(2);
    const hidden = renderDiff({ model: whitespaceOnlyDiff, showWhitespaceChanges: false });
    expect(hidden.querySelectorAll(".meridian-diff__segment--changed").length).toBe(0);
    // The characters are still there — the toggle withholds emphasis and never
    // shortens the line.
    expect(
      [...hidden.querySelectorAll(".meridian-diff__code")].map((code) => code.textContent),
    ).toStrictEqual(["const value = 1;", "const value   = 1;"]);
  });

  it("shows an attribution mark only where the trailers named somebody, and only when asked", () => {
    const withMarks = renderDiff({ showAttributionMarks: true });
    const withoutMarks = renderDiff({ showAttributionMarks: false });
    expect(withMarks.querySelectorAll(".meridian-diff__attribution-mark").length).toBeGreaterThan(
      0,
    );
    expect(withoutMarks.querySelectorAll(".meridian-diff__attribution-mark").length).toBe(0);
  });

  it("negative control: attribution comes from the line and never from the diff's own run", () => {
    // Every line here carries no trailer, so a renderer that fell back to the
    // diff's run would mark all of them — the inference `Spec-011` forbids.
    const unattributed = buildDiffFixture({
      ...SMALL_DIFF_SHAPE,
      agentAttributionEveryNthLine: 0,
    });
    const container = renderDiff({ model: unattributed, showAttributionMarks: true });
    expect(container.querySelectorAll(".meridian-diff__attribution-mark").length).toBe(0);
  });

  it("carries the wrap toggle onto the scroller", () => {
    expect(
      renderDiff({ wrapLongLines: true }).querySelector(".meridian-diff--wrap"),
    ).not.toBeNull();
    expect(renderDiff({ wrapLongLines: false }).querySelector(".meridian-diff--wrap")).toBeNull();
  });
});

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
    // One row three lines tall, and the whole diff is that much taller. With the
    // sheet at `block-size: auto` this is what the scrollbar has to report; a
    // window that multiplied a row count by a constant would report the estimate
    // and scroll past the end of the content.
    const container = renderDiff({ model: bigDiff, wrapLongLines: true });
    expect(contentHeightPx(container)).toBe(
      reportedRowCount(container) * DIFF_ROW_HEIGHT_PX + grownByPx,
    );
  });

  it("negative control: with wrap off nothing is measured and the estimate is the height", () => {
    // The same stub, the same grown row, and the unwrapped path must ignore it —
    // which is what keeps the unwrapped pane pixel-for-pixel what it was before a
    // virtualizer was adopted at all.
    const container = renderDiff({ model: bigDiff, wrapLongLines: false });
    expect(contentHeightPx(container)).toBe(reportedRowCount(container) * DIFF_ROW_HEIGHT_PX);
  });

  it("forgets the measured heights when wrap is turned back off", () => {
    // The one direction the reset is for. The rows are already mounted, so their
    // measurement refs do not fire again and nothing re-takes a height; without
    // the reset the unwrapped diff would keep spacing itself at wrapped heights.
    const props = diffRendererProps({ model: bigDiff, wrapLongLines: true });
    const { container, rerender } = render(<DiffRenderer {...props} />);
    const rowCount = reportedRowCount(container);
    expect(contentHeightPx(container)).toBe(rowCount * DIFF_ROW_HEIGHT_PX + grownByPx);

    rerender(<DiffRenderer {...props} wrapLongLines={false} />);
    expect(contentHeightPx(container)).toBe(rowCount * DIFF_ROW_HEIGHT_PX);
  });

  it("places the window below a wrapped row at the offset that row was measured at", () => {
    // Scroll past the grown row, then ask where the window was put. Every row
    // above the first rendered one is one row tall except the grown one, so the
    // offset is the row count times the row height PLUS what that one row grew
    // by — and the case is only worth anything if the scroll actually cleared it.
    const container = renderDiff({ model: bigDiff, wrapLongLines: true });
    const scroller = container.querySelector<HTMLElement>(".meridian-diff");
    expect(scroller).not.toBeNull();
    scroller!.scrollTop = 4_000;
    fireEvent.scroll(scroller!);

    const firstRowIndex = firstRenderedRowIndex(container);
    expect(firstRowIndex).toBeGreaterThan(WRAPPED_ROW.rowIndex);
    expect(windowOffsetPx(container)).toBe(firstRowIndex * DIFF_ROW_HEIGHT_PX + grownByPx);
  });

  it("negative control: the constant-height offset is not the offset it lands on", () => {
    // Without this the case above would pass over a window still placed at
    // `index x row height` whenever the grown row happened to add nothing — which
    // is exactly what the replaced arithmetic did on every scroll.
    const container = renderDiff({ model: bigDiff, wrapLongLines: true });
    const scroller = container.querySelector<HTMLElement>(".meridian-diff");
    scroller!.scrollTop = 4_000;
    fireEvent.scroll(scroller!);

    expect(windowOffsetPx(container)).not.toBe(
      firstRenderedRowIndex(container) * DIFF_ROW_HEIGHT_PX,
    );
  });
});

describe("diff renderer — expansion and emptiness", () => {
  it("replaces the expanded gap with its context, leaving the diff's other gaps alone", () => {
    // Positional rather than counted: expansion acts on ONE gap, and the row
    // immediately after the first file header is where that shows. A count would
    // also move because the window's rows shift under the newly revealed lines,
    // which would make the case pass for the wrong reason.
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

  it("says two identical states are identical, which is a read that returned nothing", () => {
    // `empty` and not `not-checked`: a diff WAS read here, and it holds no changed
    // line. The pane spends `not-checked` for the other fact.
    const container = renderDiff({ model: { ...SMALL_DIFF, files: [] } });
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
    expect(container.querySelector(".meridian-nothing--not-checked")).toBeNull();
  });
});

describe("diff renderer — the file header carries what the extended headers said", () => {
  const EXTENDED_HEADER_DIFF = buildDiffFixture(EXTENDED_HEADER_DIFF_SHAPE);

  /**
   * The file-header row for one path, narrowed to that file.
   *
   * Narrowed rather than scrolled to: a header-only file has no hunks, so it is the
   * change set's last row and a window bounded by the viewport need not reach it.
   * The narrowing is the renderer's own, so the row under assertion is the row the
   * pane draws when a reader selects that file.
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

  it("negative control: a file whose change is textual carries no note", () => {
    // Without this, a header that stamped every file with a note would pass every
    // case above while telling a reader that every file in the change set had moved.
    const container = renderDiff({ model: SMALL_DIFF });
    expect(container.querySelector(".meridian-diff__file-change")).toBeNull();
  });
});
