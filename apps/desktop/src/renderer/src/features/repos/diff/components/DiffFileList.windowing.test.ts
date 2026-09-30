// The file list as a window: what it mounts, what it does not, and what each row says about the
// slice it is in. Entry content is covered in `DiffFileList.test.tsx`.

import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DIFF_FILE_ROW_HEIGHT_PX, DIFF_WINDOW_OVERSCAN_ROWS } from "../diff-measures.js";
import { buildDiffFixture } from "@test/helpers/diff-fixture.js";
import { SMALL_DIFF_SHAPE } from "@test/helpers/diff-fixture-shapes.js";
import {
  DIFF_FIXTURE_VIEWPORT_HEIGHT_PX,
  DiffLayoutFixture,
} from "@test/helpers/diff-layout-fixture.js";
import {
  REPOSITORY_WIDE_DIFF,
  filterTo,
  firstEntry,
  fixtureFileAt,
  renderFileList,
} from "./diff-file-list.test-support.js";

const TEXTUAL_ONLY_DIFF = buildDiffFixture(SMALL_DIFF_SHAPE);

const layout = new DiffLayoutFixture();

beforeEach(() => {
  layout.install({ viewportHeightPx: DIFF_FIXTURE_VIEWPORT_HEIGHT_PX });
});

afterEach(() => {
  layout.restore();
});

describe("diff file list — a change set too long to mount", () => {
  /**
   * Mounted-entry ceiling one window may reach: the viewport's rows plus overscan on both
   * sides, plus the boundary row and the reset control.
   */
  const MAXIMUM_MOUNTED_ENTRY_COUNT =
    Math.ceil(DIFF_FIXTURE_VIEWPORT_HEIGHT_PX / DIFF_FILE_ROW_HEIGHT_PX) +
    DIFF_WINDOW_OVERSCAN_ROWS * 2 +
    2;

  function mountedEntryCount(container: HTMLElement): number {
    return container.querySelectorAll(".meridian-diff-files__entry").length;
  }

  it("mounts a window of a five-thousand-file change set rather than all of it", () => {
    // Past its threshold the list must not mount every matching file: a repository-wide patch
    // would cost thousands of buttons before the virtualized body could help.
    const container = renderFileList(REPOSITORY_WIDE_DIFF);

    expect(mountedEntryCount(container)).toBeLessThanOrEqual(MAXIMUM_MOUNTED_ENTRY_COUNT);
    // The reset control still counts every file, not the handful the window mounted.
    expect(container.querySelector(".meridian-diff-files__entry")?.textContent).toContain("5000");
  });

  it("stays bounded when the filter narrows to thousands of paths", () => {
    // The filter matches most of the change set on purpose: a bound that only held for a
    // filter matching nothing would hold for the wrong reason.
    const container = renderFileList(REPOSITORY_WIDE_DIFF);
    const filter = container.querySelector<HTMLInputElement>(".meridian-diff-files__filter-input");
    if (filter === null) {
      throw new Error("the list drew no filter input");
    }

    fireEvent.change(filter, { target: { value: "module-" } });

    expect(mountedEntryCount(container)).toBeLessThanOrEqual(MAXIMUM_MOUNTED_ENTRY_COUNT);
    expect(container.querySelector(".meridian-diff-files__no-match")).toBeNull();
  });

  it("opens the window on a selection the window would not otherwise reach", () => {
    // A narrowing whose row is off-window has no visible state, and a pane reopened on a file
    // far down opens on exactly that.
    const selected = fixtureFileAt(REPOSITORY_WIDE_DIFF, 4_000).path;
    const container = renderFileList(REPOSITORY_WIDE_DIFF, selected);

    const current = container.querySelector('.meridian-diff-files__entry[aria-current="true"]');
    expect(current?.textContent).toContain(selected);
    expect(mountedEntryCount(container)).toBeLessThanOrEqual(MAXIMUM_MOUNTED_ENTRY_COUNT);
  });

  it("negative control: a change set under the threshold mounts every entry", () => {
    // Negative control: a list that mounted nothing (happy-dom reports a zero viewport) would
    // satisfy every bound above.
    const container = renderFileList(TEXTUAL_ONLY_DIFF);
    expect(mountedEntryCount(container)).toBe(SMALL_DIFF_SHAPE.fileCount + 1);
  });
});

describe("diff file list — reaching an entry the window has not mounted", () => {
  function focusedEntryIndex(container: HTMLElement): number {
    const row = container.ownerDocument.activeElement?.closest(".meridian-diff-files__row");
    return Number(row?.getAttribute("data-index") ?? Number.NaN);
  }

  it("moves between entries on the arrow keys, because tab can only reach the window", () => {
    // Tab reaches only the mounted rows; the list is one tab stop with arrows inside it, which
    // keeps every entry reachable.
    //
    // This tier cannot see whether the focus ring moved: happy-dom focuses any element, an
    // `<li>` without `tabindex` included. `tests/browser/windowed-list-focus.test.tsx` covers
    // that in Chromium; this case asserts the index arithmetic.
    const container = renderFileList(TEXTUAL_ONLY_DIFF);
    firstEntry(container).focus();

    fireEvent.keyDown(firstEntry(container), { key: "ArrowDown" });
    expect(focusedEntryIndex(container)).toBe(1);

    fireEvent.keyDown(container.ownerDocument.activeElement!, { key: "ArrowUp" });
    expect(focusedEntryIndex(container)).toBe(0);
  });

  it("takes the ends of the list without walking it", () => {
    const container = renderFileList(TEXTUAL_ONLY_DIFF);
    firstEntry(container).focus();

    fireEvent.keyDown(firstEntry(container), { key: "End" });
    // The reset control plus one entry per file, so the last index is the file count.
    expect(focusedEntryIndex(container)).toBe(SMALL_DIFF_SHAPE.fileCount);

    fireEvent.keyDown(container.ownerDocument.activeElement!, { key: "Home" });
    expect(focusedEntryIndex(container)).toBe(0);
  });

  it("keeps exactly one entry in the page's tab order", () => {
    // A windowed list that left every mounted row tabbable would put a moving number of tab
    // stops in the page.
    const container = renderFileList(TEXTUAL_ONLY_DIFF);
    const tabbable = [...container.querySelectorAll(".meridian-diff-files__entry")].filter(
      (entry) => entry.getAttribute("tabindex") === "0",
    );
    expect(tabbable).toHaveLength(1);
  });

  it("negative control: a key the list does not own moves nothing", () => {
    // A handler that moved on every key would satisfy the cases above while stealing the
    // character typed into the filter.
    const container = renderFileList(TEXTUAL_ONLY_DIFF);
    firstEntry(container).focus();

    fireEvent.keyDown(firstEntry(container), { key: "a" });

    expect(focusedEntryIndex(container)).toBe(0);
  });
});

describe("diff file list — a window is a slice, and each row says so", () => {
  function rowPositionAt(
    container: HTMLElement,
    entryIndex: number,
  ): [string | null, string | null] {
    const row = container.querySelector(
      `.meridian-diff-files__row[data-index="${String(entryIndex)}"]`,
    );
    if (row === null) {
      throw new Error(`the window did not mount the row at ${String(entryIndex)}`);
    }
    return [row.getAttribute("aria-setsize"), row.getAttribute("aria-posinset")];
  }

  it("reports the whole change set's length and each row's place in it", () => {
    // Only the window's rows are in the accessibility tree, so without these a screen reader
    // reads the slice as the whole list.
    const container = renderFileList(REPOSITORY_WIDE_DIFF);

    // The reset control plus one row per file, which is the list the `<ul>` holds.
    const setSize = String(REPOSITORY_WIDE_DIFF.files.length + 1);
    expect(rowPositionAt(container, 0)).toStrictEqual([setSize, "1"]);
    expect(rowPositionAt(container, 1)).toStrictEqual([setSize, "2"]);
  });

  it("counts a filtered list as the rows that filter leaves", () => {
    // The set is what the list draws, so a filter shortens it; a row claiming a place in five
    // thousand while nine are drawn would be as wrong as the slice.
    const container = renderFileList(REPOSITORY_WIDE_DIFF);

    filterTo(container, "module-01");

    const [setSize] = rowPositionAt(container, 0);
    expect(Number(setSize)).toBe(container.querySelectorAll(".meridian-diff-files__row").length);
  });

  it("negative control: the position is the row's own and not the window's", () => {
    // Rows numbered from the top of the mounted window would pass the first case for row zero
    // and misreport every row below the fold.
    const container = renderFileList(
      REPOSITORY_WIDE_DIFF,
      fixtureFileAt(REPOSITORY_WIDE_DIFF, 4_000).path,
    );

    const rows = [...container.querySelectorAll(".meridian-diff-files__row")];
    const first = rows[0];
    if (first === undefined) {
      throw new Error("the window mounted no row at all");
    }
    expect(Number(first.getAttribute("aria-posinset"))).toBeGreaterThan(1);
  });
});
