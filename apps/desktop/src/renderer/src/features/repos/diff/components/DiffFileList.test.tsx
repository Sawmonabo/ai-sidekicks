// The changed-file list over the diff tests' fixture: what it mounts of a long change set, how
// the keyboard reaches entries the window has not mounted, and what survives a filter or a new
// change set. Every case states the pane height: the list is windowed and happy-dom reports every
// box as zero, so a bound on mounted rows would hold for an empty list.

import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DIFF_FILE_ROW_HEIGHT_PX, DIFF_WINDOW_OVERSCAN_ROWS } from "../diff-measures.js";
import { buildDiffFixture } from "@test/helpers/diff-fixture.js";
import { EXTENDED_HEADER_DIFF_SHAPE, SMALL_DIFF_SHAPE } from "@test/helpers/diff-fixture-shapes.js";
import {
  DIFF_FIXTURE_VIEWPORT_HEIGHT_PX,
  DiffLayoutFixture,
} from "@test/helpers/diff-layout-fixture.js";
import { DiffFileList } from "./DiffFileList.js";
import {
  REPOSITORY_WIDE_DIFF,
  filterTo,
  firstEntry,
  fixtureFileAt,
  renderFileList,
  tabbableEntryCount,
} from "./diff-file-list.test-support.js";

const EXTENDED_HEADER_DIFF = buildDiffFixture(EXTENDED_HEADER_DIFF_SHAPE);
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

  it("opens the window on a selection the window would not otherwise reach", () => {
    // A narrowing whose row is off-window has no visible state, and a pane reopened on a file
    // far down opens on exactly that.
    const selected = fixtureFileAt(REPOSITORY_WIDE_DIFF, 4_000).path;
    const container = renderFileList(REPOSITORY_WIDE_DIFF, selected);

    const current = container.querySelector('.meridian-diff-files__entry[aria-current="true"]');
    expect(current?.textContent).toContain(selected);
    expect(mountedEntryCount(container)).toBeLessThanOrEqual(MAXIMUM_MOUNTED_ENTRY_COUNT);
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
});

describe("diff file list — the filter belongs to the change set it filters", () => {
  function filterInputText(container: HTMLElement): string {
    return (
      container.querySelector<HTMLInputElement>(".meridian-diff-files__filter-input")?.value ?? ""
    );
  }

  it("drops the filter when the pane is pointed at another change set", () => {
    // The list is not keyed, so a bare register would keep the previous change set's filter
    // and draw "No changed file matches that filter." over a change set that has files.
    const { container, rerender } = render(
      <DiffFileList
        diff={EXTENDED_HEADER_DIFF}
        selectedFilePath={undefined}
        onSelectFilePath={() => undefined}
      />,
    );
    filterTo(container, fixtureFileAt(EXTENDED_HEADER_DIFF, 0).path);
    expect(filterInputText(container)).not.toBe("");

    rerender(
      <DiffFileList
        diff={TEXTUAL_ONLY_DIFF}
        selectedFilePath={undefined}
        onSelectFilePath={() => undefined}
      />,
    );

    expect(filterInputText(container)).toBe("");
    expect(container.textContent).not.toContain("No changed file matches that filter.");
  });
});

describe("diff file list — a move made in a list that then changed", () => {
  it("keeps the list in the page's tab order after a filter comes and goes", () => {
    // A move must not survive a filter that shrank the entry set: clearing the filter would
    // restore an index far below the window and leave every mounted button `tabIndex={-1}`.
    const container = renderFileList(REPOSITORY_WIDE_DIFF);
    fireEvent.keyDown(firstEntry(container), { key: "End" });

    filterTo(container, "module-01");
    filterTo(container, "");

    expect(tabbableEntryCount(container)).toBe(1);
  });
});
