// The browser tier: a windowed list's arrow keys actually move the focus ring.
//
// WHY THIS CANNOT LIVE IN THE UNIT TIER, which is the whole reason the file exists.
// `console-unit` runs happy-dom, whose `focus()` sets `document.activeElement` on ANY
// element — an `<li>` with no `tabindex` included. Chromium does not: focusing an
// element that is not focusable is a no-op and the ring stays where it was. So a list
// whose row marked ITSELF as the roving focus target while the tab stop sat on the
// button inside it passed every unit case that asserted the move, and in a real
// browser the ring never moved, the next Tab left the list, and `aria-current` walked
// away from the focused control. The last case below is the control for that claim: it
// plants exactly that shape and proves this engine refuses it.
//
// TWO LISTS, BECAUSE THE FAMILY HAS TWO. The changed-file list and the restore-path
// enumeration both window, both put a control in every row, and both delegate their
// stop through `WindowedListRow`'s renderer form. A case per list is what keeps one of
// them from regressing behind the other's green.
//
// The rows are all mounted here rather than windowed away: the claim is about which
// ELEMENT the keyboard lands on, and a fixture small enough to mount whole is the
// shape where a failure is unambiguous.

import { describe, expect, it } from "vitest";

import { pressKeys, renderSettled } from "../console-harness.js";

import { DiffFileList } from "../../../src/renderer/src/console/repos/diff-pane/DiffFileList.js";
import { buildDiffFixture } from "../../../src/renderer/src/console/repos/diff-pane/diff-fixture.test-support.js";
import { SMALL_DIFF_SHAPE } from "../../../src/renderer/src/console/repos/diff-pane/diff-fixture-shapes.test-support.js";
import { WindowedRestorePathList } from "../../../src/renderer/src/console/primitives/restore/WindowedRestorePathList.js";

/** The attribute a row writes on whichever element holds its tab stop. */
const ROW_TARGET_SELECTOR = "[data-row-target]";

/** Paths enough to window, named so a failure says which row was reached. */
const RESTORE_PATHS: readonly string[] = Array.from(
  { length: 40 },
  (_unused, position) =>
    `packages/control-plane/src/module-${String(position).padStart(2, "0")}.ts`,
);

/**
 * The element that currently holds the page's focus, as an element.
 *
 * `document.activeElement` is `Element | null` and every assertion below is about a
 * control, so the narrowing happens once here rather than at each call site.
 */
function focusedElement(): Element | null {
  return document.activeElement;
}

describe("browser — a windowed list's arrow keys move the focus ring", () => {
  it("moves focus to the next changed file's own control", async () => {
    const { container } = await renderSettled(
      <DiffFileList
        diff={buildDiffFixture(SMALL_DIFF_SHAPE)}
        selectedFilePath={undefined}
        onSelectFilePath={() => undefined}
      />,
    );
    const rows = [...container.querySelectorAll(".meridian-diff-files__row")];
    expect(rows.length).toBeGreaterThan(1);

    const firstControl = rows[0]?.querySelector("button");
    firstControl?.focus();
    expect(focusedElement()).toBe(firstControl);

    await pressKeys("{ArrowDown}");

    // The RING moved, not merely the roving index: the second row's own button holds
    // the focus, which is what a person sees and what the next Tab leaves from.
    expect(focusedElement()).toBe(rows[1]?.querySelector("button"));
    expect(focusedElement()).not.toBe(firstControl);
  });

  it("moves focus to the next restore path's own control", async () => {
    const { container } = await renderSettled(
      <WindowedRestorePathList
        label="Overwritten paths"
        paths={RESTORE_PATHS}
        onOpenPath={() => undefined}
      />,
    );
    const rows = [...container.querySelectorAll("li")];
    expect(rows.length).toBeGreaterThan(1);

    const firstControl = rows[0]?.querySelector("button");
    firstControl?.focus();
    expect(focusedElement()).toBe(firstControl);

    await pressKeys("{ArrowDown}");

    expect(focusedElement()).toBe(rows[1]?.querySelector("button"));
  });

  it("marks the control as the focus target, never the row around it", async () => {
    // The structural half of the same claim, and the one that names the defect: the
    // roving effect resolves a move to a row and then focuses whatever that row MARKED,
    // testing the row itself first. A row that marked itself handed the effect an
    // element this engine will not focus.
    const { container } = await renderSettled(
      <DiffFileList
        diff={buildDiffFixture(SMALL_DIFF_SHAPE)}
        selectedFilePath={undefined}
        onSelectFilePath={() => undefined}
      />,
    );
    const marked = [...container.querySelectorAll(ROW_TARGET_SELECTOR)];
    expect(marked.length).toBeGreaterThan(0);
    for (const element of marked) {
      expect(element.tagName).toBe("BUTTON");
    }
    for (const row of container.querySelectorAll(".meridian-diff-files__row")) {
      expect(row.matches(ROW_TARGET_SELECTOR)).toBe(false);
      // One stop per row, so exactly one element inside it is marked.
      expect(row.querySelectorAll(ROW_TARGET_SELECTOR)).toHaveLength(1);
    }
  });

  it("negative control: this engine refuses to focus a row with no tabindex", async () => {
    // Why the three cases above are in the browser tier and not beside the components.
    // Under happy-dom this expectation is false — `focus()` there sets
    // `activeElement` to the `<li>` — so a unit-tier copy of those cases would pass
    // over the exact shape they exist to refuse.
    const list = document.createElement("ul");
    const row = document.createElement("li");
    list.append(row);
    document.body.append(list);
    try {
      document.body.focus();
      row.focus();
      expect(focusedElement()).not.toBe(row);
    } finally {
      list.remove();
    }
  });
});
