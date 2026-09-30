// The browser tier: a windowed list's arrow keys actually move the focus ring.
//
// happy-dom's `focus()` sets `document.activeElement` on any element, an `<li>` with no
// `tabindex` included; Chromium treats focusing a non-focusable element as a no-op. A list whose
// row marked itself as the roving focus target while the tab stop sat on the button inside it
// would pass every unit case that asserted the move, while in a real browser the ring never
// moves. The last case plants that shape and proves this engine refuses it.
//
// The list is the changed-file list, which windows, puts a control in every row, and delegates
// its tab stop through `WindowedListRow`'s renderer form. Its rows are all mounted here because
// the claim is about which element the keyboard lands on.

import { describe, expect, it } from "vitest";

import { pressKeys, renderSettled } from "../helpers/app-harness.js";

import { DiffFileList } from "@renderer/features/repos/diff/components/DiffFileList.js";
import { buildDiffFixture } from "../helpers/diff-fixture.js";
import { SMALL_DIFF_SHAPE } from "../helpers/diff-fixture-shapes.js";

/** The attribute a row writes on whichever element holds its tab stop. */
const ROW_TARGET_SELECTOR = "[data-row-target]";

/** The element that currently holds the page's focus. */
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

    // The ring moved, not merely the roving index: the second row's own button holds the focus.
    expect(focusedElement()).toBe(rows[1]?.querySelector("button"));
    expect(focusedElement()).not.toBe(firstControl);
  });

  it("marks the control as the focus target, never the row around it", async () => {
    // The structural half: the roving effect resolves a move to a row and focuses whatever that
    // row marked, testing the row itself first, so a row that marked itself would hand it an
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
    // Under happy-dom this expectation is false (`focus()` sets `activeElement` to the `<li>`),
    // so a unit-tier copy of the cases above would pass over the shape they refuse.
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
