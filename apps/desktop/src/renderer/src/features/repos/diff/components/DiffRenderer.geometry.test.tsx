// A diff row under a window: the offsets under a wrapped line, an expansion that mounts rows
// the window had elided, the extended headers a file header draws, and the marker for a file
// that ends without a newline. Row kinds and view controls are in `DiffRenderer.test.ts`.

import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DIFF_ROW_HEIGHT_PX } from "../diff-measures.js";
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
import { SMALL_DIFF, renderDiff, reportedRowCount } from "./diff-renderer.test-support.js";
import { expandGap } from "../diff-row-model.js";

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

  it("negative control: the constant-height offset is not the offset it lands on", () => {
    // Negative control: a window still placed at `index x row height` passes above whenever
    // the grown row happens to add nothing.
    const container = renderDiff({ model: bigDiff });
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

  it("negative control: a file whose change is textual carries no note", () => {
    // Negative control: a header that stamped every file with a note would pass above.
    const container = renderDiff({ model: SMALL_DIFF });
    expect(container.querySelector(".meridian-diff__file-change")).toBeNull();
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

  it("negative control: an ordinary change set draws the annotation nowhere", () => {
    // Negative control: a row that stamped every last line would pass above.
    const container = renderDiff({ model: SMALL_DIFF });
    expect(container.querySelector(".meridian-diff__no-newline")).toBeNull();
  });
});
