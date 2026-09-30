// A transcript row says where it sits in the whole log, or says nothing. The position pair and
// index attribute are delegated to `WindowedListRow`; these cases assert the rendered markup, so
// its fail-closed arm is what is driven.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WINDOWED_ROW_INDEX_ATTRIBUTE } from "@renderer/lib/windowed-row-markers.js";
import { VirtualRow } from "./VirtualRow.js";
import type { ViewportRow } from "../viewport-snapshot.js";

const ROW: ViewportRow = {
  key: "row-4000",
  parentKey: undefined,
  rootCursor: "cursor-1",
};

function renderMount(rowIndex: number, totalRowCount: number): HTMLElement {
  const { container } = render(
    <VirtualRow
      rowIndex={rowIndex}
      totalRowCount={totalRowCount}
      row={ROW}
      renderRow={(row): React.ReactNode => <span>{row.key}</span>}
      attachRow={(): void => {}}
    />,
  );
  const row = container.querySelector<HTMLElement>(".meridian-transcript-viewport__row");
  if (row === null) {
    throw new Error("TranscriptRowMount rendered no row element");
  }
  return row;
}

describe("TranscriptRowMount — where the row sits in the whole log", () => {
  it("announces its one-based position and the whole log's length", () => {
    const row = renderMount(3, 4000);
    expect(row.getAttribute("role")).toBe("article");
    expect(row.getAttribute("aria-posinset")).toBe("4");
    expect(row.getAttribute("aria-setsize")).toBe("4000");
    expect(row.getAttribute(WINDOWED_ROW_INDEX_ATTRIBUTE)).toBe("3");
  });

  it("fails closed on an index the pruned count no longer holds", () => {
    // The cap evicted rows, so the count is recomputed to 3 950 while a row painted at 4 000
    // outlives one frame; "entry 4 001 of 3 950" would be false, so the row claims no position.
    const row = renderMount(4000, 3950);
    expect(row.getAttribute("aria-setsize")).toBe("-1");
    expect(row.getAttribute("aria-posinset")).toBeNull();
    // The virtualizer's index is withheld on the same predicate, so the keyboard cannot land here.
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
