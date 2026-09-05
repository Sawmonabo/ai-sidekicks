// A ledger row says where it sits in the whole log, or says nothing at all.
//
// The subject is the position pair and the index attribute, which this module
// delegates to `primitives/WindowedListRow` rather than writing. What that buys is
// the fail-closed arm: the window cap prunes, so a row already painted at an index
// the recomputed count no longer holds survives one paint, and an unconditional pair
// announces a position outside the list. These cases drive the mount itself, so the
// delegation is asserted through the rendered markup rather than by reading imports.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WINDOWED_ROW_INDEX_ATTRIBUTE } from "../../primitives/index.js";
import { LedgerRowMount } from "./LedgerRowMount.js";
import type { LedgerViewportRow } from "./viewport-snapshot.js";

const ROW: LedgerViewportRow = {
  key: "row-4000",
  parentKey: undefined,
  rootCursor: "cursor-1",
};

function renderMount(rowIndex: number, totalRowCount: number): HTMLElement {
  const { container } = render(
    <LedgerRowMount
      rowIndex={rowIndex}
      totalRowCount={totalRowCount}
      row={ROW}
      renderRow={(row): React.ReactNode => <span>{row.key}</span>}
      attachRow={(): void => {}}
    />,
  );
  const row = container.querySelector<HTMLElement>(".meridian-ledger-viewport__row");
  if (row === null) {
    throw new Error("LedgerRowMount rendered no row element");
  }
  return row;
}

describe("LedgerRowMount — where the row sits in the whole log", () => {
  it("announces its one-based position and the whole log's length", () => {
    const row = renderMount(3, 4000);
    expect(row.getAttribute("role")).toBe("article");
    expect(row.getAttribute("aria-posinset")).toBe("4");
    expect(row.getAttribute("aria-setsize")).toBe("4000");
    expect(row.getAttribute(WINDOWED_ROW_INDEX_ATTRIBUTE)).toBe("3");
  });

  it("fails closed on an index the pruned count no longer holds", () => {
    // The prune sequence: the cap evicted rows, so the count is recomputed to 3 950
    // while a row painted at 4 000 outlives one frame. "Entry 4 001 of 3 950" is not
    // a smaller reading of the truth, so the row claims no position at all.
    const row = renderMount(4000, 3950);
    expect(row.getAttribute("aria-setsize")).toBe("-1");
    expect(row.getAttribute("aria-posinset")).toBeNull();
    // And the keyboard cannot land on a row that withheld its position, so the index
    // the virtualizer resolves an element through is withheld on the same predicate.
    expect(row.getAttribute(WINDOWED_ROW_INDEX_ATTRIBUTE)).toBeNull();
  });

  it("fails closed on a placeholder row that holds no index at all", () => {
    const row = renderMount(-1, 12);
    expect(row.getAttribute("aria-setsize")).toBe("-1");
    expect(row.getAttribute("aria-posinset")).toBeNull();
    expect(row.getAttribute(WINDOWED_ROW_INDEX_ATTRIBUTE)).toBeNull();
  });

  it("negative control: the row it CAN place carries all three, so the arm above is the predicate and not a blank render", () => {
    // Without this the two cases above would pass on a component that wrote nothing.
    const placed = renderMount(0, 1);
    expect(placed.getAttribute("aria-setsize")).toBe("1");
    expect(placed.getAttribute("aria-posinset")).toBe("1");
    expect(placed.getAttribute(WINDOWED_ROW_INDEX_ATTRIBUTE)).toBe("0");
    // The last index of the enumeration is inside it; the one past it is not.
    expect(renderMount(11, 12).getAttribute("aria-posinset")).toBe("12");
    expect(renderMount(12, 12).getAttribute("aria-posinset")).toBeNull();
  });

  it("draws the row body inside the row's own box", () => {
    const row = renderMount(1, 9);
    expect(row.textContent).toContain("row-4000");
  });
});
