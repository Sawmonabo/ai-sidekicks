// The file list as a window: what it mounts, what it does not, and what each row says
// about which slice it is in.
//
// WHAT AN ENTRY IS is `DiffFileList.test.tsx` — a change that lives only in the
// extended headers, a narrowing the filter hides, and a move made in a list that then
// changed. Every case here is about the WINDOW rather than the entry: a change set too
// long to mount, an entry reached past the mounted slice, and the row that names the
// slice it is in.

import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DIFF_FILE_ROW_HEIGHT_PX, DIFF_WINDOW_OVERSCAN_ROWS } from "./diff-bounds.js";
import { buildDiffFixture } from "./diff-fixture.test-support.js";
import { SMALL_DIFF_SHAPE } from "./diff-fixture-shapes.test-support.js";
import {
  DIFF_FIXTURE_VIEWPORT_HEIGHT_PX,
  DiffLayoutFixture,
} from "./diff-layout-fixture.test-support.js";
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

/** The change note on one path's entry, or `undefined` where it drew none. */
describe("diff file list — a change set too long to mount", () => {
  /**
   * The mounted-entry ceiling one window may reach.
   *
   * Derived from the bounds rather than picked, exactly as the rows renderer's is:
   * the viewport's own rows plus overscan on both sides, plus the boundary row and
   * the reset control. A list that mounted more than this is not windowing.
   */
  const MAXIMUM_MOUNTED_ENTRY_COUNT =
    Math.ceil(DIFF_FIXTURE_VIEWPORT_HEIGHT_PX / DIFF_FILE_ROW_HEIGHT_PX) +
    DIFF_WINDOW_OVERSCAN_ROWS * 2 +
    2;

  function mountedEntryCount(container: HTMLElement): number {
    return container.querySelectorAll(".meridian-diff-files__entry").length;
  }

  it("mounts a window of a five-thousand-file change set rather than all of it", () => {
    // The whole defect: past its threshold the list added a scrolling class and
    // mounted every matching file anyway, so a generated or repository-wide patch
    // cost thousands of buttons before the already virtualized body could help.
    const container = renderFileList(REPOSITORY_WIDE_DIFF);

    expect(mountedEntryCount(container)).toBeLessThanOrEqual(MAXIMUM_MOUNTED_ENTRY_COUNT);
    // And the list is still ABOUT the whole change set: the reset control counts every
    // file, not the handful the window mounted.
    expect(container.querySelector(".meridian-diff-files__entry")?.textContent).toContain("5000");
  });

  it("stays bounded when the filter narrows to thousands of paths", () => {
    // A keystroke rebuilds the entry list, and the list that was rebuilt used to be
    // every matching row. The filter below matches most of the change set on purpose:
    // a bound that only held for a filter matching nothing would hold for the wrong
    // reason.
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
    // A narrowing whose row is off-window is a control a reader cannot see the state
    // of — and a pane reopened on a file a thousand rows down opens on exactly that.
    const selected = fixtureFileAt(REPOSITORY_WIDE_DIFF, 4_000).path;
    const container = renderFileList(REPOSITORY_WIDE_DIFF, selected);

    const current = container.querySelector('.meridian-diff-files__entry[aria-current="true"]');
    expect(current?.textContent).toContain(selected);
    expect(mountedEntryCount(container)).toBeLessThanOrEqual(MAXIMUM_MOUNTED_ENTRY_COUNT);
  });

  it("negative control: a change set under the threshold mounts every entry", () => {
    // Without this, every bound above would be satisfied by a list that mounted
    // nothing at all — which is what a windowed list does against a viewport a DOM
    // shim reports as zero.
    const container = renderFileList(TEXTUAL_ONLY_DIFF);
    expect(mountedEntryCount(container)).toBe(SMALL_DIFF_SHAPE.fileCount + 1);
  });
});

describe("diff file list — reaching an entry the window has not mounted", () => {
  /** The entry a browser would move focus to, by the index its own row carries. */
  function focusedEntryIndex(container: HTMLElement): number {
    const row = container.ownerDocument.activeElement?.closest(".meridian-diff-files__row");
    return Number(row?.getAttribute("data-index") ?? Number.NaN);
  }

  it("moves between entries on the arrow keys, because tab can only reach the window", () => {
    // A window mounts the rows a scroll position needs, so tabbing reaches those and
    // no others. The list is one tab stop with the arrows inside it, which is what
    // keeps every entry reachable however few of them are mounted.
    //
    // THIS TIER CANNOT SEE WHETHER THE RING ACTUALLY MOVED. happy-dom focuses any
    // element it is asked to, an `<li>` with no `tabindex` included, so this case
    // passed over a list whose row marked itself as the focus target and whose ring
    // therefore never moved in a browser. `test/console/browser/
    // repos-windowed-focus.test.tsx` is where that claim is made, in Chromium, with
    // the engine's refusal as its own control. What is asserted here is the INDEX
    // arithmetic, which is this tier's to own.
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
    // The other half of the composite-widget rule: a windowed list that left every
    // mounted row tabbable would put a moving number of tab stops in the page.
    const container = renderFileList(TEXTUAL_ONLY_DIFF);
    const tabbable = [...container.querySelectorAll(".meridian-diff-files__entry")].filter(
      (entry) => entry.getAttribute("tabindex") === "0",
    );
    expect(tabbable).toHaveLength(1);
  });

  it("negative control: a key the list does not own moves nothing", () => {
    // Without this, a handler that moved on every key would satisfy the cases above
    // while stealing the character a person is typing into the filter beside it.
    const container = renderFileList(TEXTUAL_ONLY_DIFF);
    firstEntry(container).focus();

    fireEvent.keyDown(firstEntry(container), { key: "a" });

    expect(focusedEntryIndex(container)).toBe(0);
  });
});

describe("diff file list — a window is a slice, and each row says so", () => {
  /** The set size and position one mounted row reports, by its own index. */
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
    // Only the window's rows exist in the accessibility tree, so without these a
    // screen reader reads a thirty-row slice as the complete changed-file list.
    const container = renderFileList(REPOSITORY_WIDE_DIFF);

    // The reset control plus one row per file, which is the list the `<ul>` holds.
    const setSize = String(REPOSITORY_WIDE_DIFF.files.length + 1);
    expect(rowPositionAt(container, 0)).toStrictEqual([setSize, "1"]);
    expect(rowPositionAt(container, 1)).toStrictEqual([setSize, "2"]);
  });

  it("counts a filtered list as the rows that filter leaves", () => {
    // The set is what the list DRAWS, so a filter shortens it — a row claiming a
    // place in five thousand while nine are drawn would be as wrong as the slice.
    const container = renderFileList(REPOSITORY_WIDE_DIFF);

    filterTo(container, "module-01");

    const [setSize] = rowPositionAt(container, 0);
    expect(Number(setSize)).toBe(container.querySelectorAll(".meridian-diff-files__row").length);
  });

  it("negative control: the position is the row's own and not the window's", () => {
    // Without this, rows numbered from the top of the mounted window would satisfy
    // the first case for row zero and misreport every row below the fold.
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
