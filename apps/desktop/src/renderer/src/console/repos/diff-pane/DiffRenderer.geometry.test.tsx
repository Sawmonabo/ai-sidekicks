// A diff row under a window: where it wraps, what expands, and what a header carries.
//
// WHAT A ROW IS is the other half of this pair, in `DiffRenderer.test.tsx` — the row
// kinds, the two-hue rule, and the view controls the renderer is handed. Every case
// here is about a row's GEOMETRY or its provenance: the offsets under a wrapped line,
// an expansion that mounts rows a window had elided, the extended headers a file
// header draws, and the marker that says a file ends without a newline.

import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DIFF_ROW_HEIGHT_PX } from "./diff-bounds.js";
import { buildDiffFixture } from "./diff-fixture.test-support.js";
import {
  ENDURANCE_DIFF_SHAPE,
  EXTENDED_HEADER_DIFF_SHAPE,
  EXTENDED_HEADER_FIXTURE_FILES,
  SMALL_DIFF_SHAPE,
  TERMINAL_NEWLINE_FIXTURE_FILE,
} from "./diff-fixture-shapes.test-support.js";
import {
  DIFF_FIXTURE_VIEWPORT_HEIGHT_PX,
  DiffLayoutFixture,
  type DiffGrownRow,
} from "./diff-layout-fixture.test-support.js";
import { DiffRenderer } from "./DiffRenderer.js";
import {
  SMALL_DIFF,
  diffRendererProps,
  renderDiff,
  reportedRowCount,
} from "./diff-renderer.test-support.js";
import { expandGap } from "./diff-row-model.js";

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
    // The whole subject: the deletion and the insertion are the same characters, so
    // without the annotation the pane draws two rows a reader cannot tell apart and
    // gives no account of what the change was.
    const rows = terminalNewlineRows("unified");
    const annotated = rows.filter(
      (row) => row.querySelector(".meridian-diff__no-newline") !== null,
    );

    expect(annotated).toHaveLength(1);
    expect(annotated[0]?.textContent).toContain("No newline at end of file");
    expect(annotated[0]?.textContent).toContain(TERMINAL_NEWLINE_FIXTURE_FILE.lastLine);
  });

  it("puts the annotation on the side that carries it in split view", () => {
    // A paired row holds a deletion and an insertion at once, and only one of them
    // is the line without a terminator — so a marker drawn on the row rather than
    // the cell would claim it of both.
    const [pairedRow] = terminalNewlineRows("split").filter(
      (row) => row.querySelector(".meridian-diff__no-newline") !== null,
    );
    const headCell = pairedRow?.querySelector(".meridian-diff__side--head");
    const baseCell = pairedRow?.querySelector(".meridian-diff__side--base");

    expect(headCell?.querySelector(".meridian-diff__no-newline")).not.toBeNull();
    expect(baseCell?.querySelector(".meridian-diff__no-newline")).toBeNull();
  });

  it("negative control: an ordinary change set draws the annotation nowhere", () => {
    // Without this, a row that stamped every last line would pass the cases above
    // while telling a reader that every file in the change set ends without a
    // newline.
    const container = renderDiff({ model: SMALL_DIFF });
    expect(container.querySelector(".meridian-diff__no-newline")).toBeNull();
  });
});
