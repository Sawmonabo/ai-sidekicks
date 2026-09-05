// The pair, and the one case where the pair is a lie.
//
// A windowed row's two ARIA members are one claim about where the row sits in the
// whole enumeration, and the failure this component exists to prevent is not that
// they are wrong — it is that they are ABSENT, and the reader is then told the list
// is as long as the window. So the clean assertions check both members against the
// enumeration rather than against the mounted slice, and the fail-closed case checks
// that an index which is not a position declares the set unknown instead of claiming
// a neighbour's place.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WindowedListRow } from "./WindowedListRow.js";
import { WINDOWED_ROW_INDEX_ATTRIBUTE } from "./windowed-row-index.js";

function renderRow(element: React.JSX.Element): HTMLElement {
  const { container } = render(element);
  const row = container.firstElementChild;
  if (!(row instanceof HTMLElement)) {
    throw new Error("WindowedListRow rendered no element");
  }
  return row;
}

describe("WindowedListRow — a slice says where it sits in the whole", () => {
  it("carries the enumeration's size and the row's one-based position", () => {
    const row = renderRow(<WindowedListRow as="li" rowIndex={2} totalRowCount={4000} />);
    expect(row.getAttribute("aria-setsize")).toBe("4000");
    expect(row.getAttribute("aria-posinset")).toBe("3");
  });

  it("negative control: it does not report the window's length", () => {
    // The defect in terms: a row that took the mounted count would answer "3 of 12"
    // for row 3 of four thousand. Asserting the pair against the enumeration is only
    // meaningful if a window-sized answer is a different string, which this pins.
    const row = renderRow(<WindowedListRow as="li" rowIndex={2} totalRowCount={12} />);
    expect(row.getAttribute("aria-setsize")).toBe("12");
    expect(row.getAttribute("aria-setsize")).not.toBe("4000");
  });

  it("writes the index attribute the roving lookup reads", () => {
    // One seam: the module that queries this attribute declares it, so this asserts
    // the writer against the reader's own name rather than against a literal.
    const row = renderRow(<WindowedListRow as="div" rowIndex={7} totalRowCount={9} />);
    expect(row.dataset["index"]).toBe("7");
  });

  it("keeps the caller's element, role, class, and placement", () => {
    const row = renderRow(
      <WindowedListRow
        as="div"
        role="option"
        rowIndex={0}
        totalRowCount={2}
        className="meridian-test-row"
        style={{ transform: "translateY(40px)" }}
      />,
    );
    expect(row.tagName).toBe("DIV");
    expect(row.getAttribute("role")).toBe("option");
    expect(row.className).toBe("meridian-test-row");
    expect(row.style.transform).toBe("translateY(40px)");
  });

  it("is a list item where the caller's semantics are the element's", () => {
    expect(renderRow(<WindowedListRow as="li" rowIndex={0} totalRowCount={1} />).tagName).toBe(
      "LI",
    );
  });
});

describe("WindowedListRow — the tab stop", () => {
  it("names no tab index where the list is not a composite widget", () => {
    const row = renderRow(<WindowedListRow as="li" rowIndex={0} totalRowCount={3} />);
    expect(row.hasAttribute("tabindex")).toBe(false);
  });

  it("puts the stop on the active row and takes it off the rest", () => {
    expect(
      renderRow(<WindowedListRow as="li" rowIndex={0} totalRowCount={3} isTabbable />).getAttribute(
        "tabindex",
      ),
    ).toBe("0");
    expect(
      renderRow(
        <WindowedListRow as="li" rowIndex={1} totalRowCount={3} isTabbable={false} />,
      ).getAttribute("tabindex"),
    ).toBe("-1");
  });
});

describe("WindowedListRow — fail-closed on an index that is not a position", () => {
  it("declares the set unknown and claims no position", () => {
    for (const rowIndex of [-1, 5, 1.5, Number.NaN]) {
      const row = renderRow(<WindowedListRow as="li" rowIndex={rowIndex} totalRowCount={5} />);
      expect(row.getAttribute("aria-setsize"), `index ${String(rowIndex)}`).toBe("-1");
      expect(row.hasAttribute("aria-posinset"), `index ${String(rowIndex)}`).toBe(false);
    }
  });

  it("negative control: a valid index at the last position is still a position", () => {
    // Without this the fail-closed arm could be satisfied by an off-by-one that
    // refused the whole tail of every enumeration.
    const row = renderRow(<WindowedListRow as="li" rowIndex={4} totalRowCount={5} />);
    expect(row.getAttribute("aria-setsize")).toBe("5");
    expect(row.getAttribute("aria-posinset")).toBe("5");
  });

  it("withholds the index attribute the keyboard resolves against", () => {
    // The rule applied to the member a person actually moves through the list with.
    // `windowed-row-index.ts` resolves `[data-index="N"]` with `querySelector`,
    // which takes the FIRST match, so two rows written with the same out-of-range
    // index are one row to the keyboard — a position claimed in the one place the
    // ARIA pair had just refused to claim it.
    for (const rowIndex of [-1, 5, 1.5, Number.NaN]) {
      const row = renderRow(<WindowedListRow as="li" rowIndex={rowIndex} totalRowCount={5} />);
      expect(row.hasAttribute(WINDOWED_ROW_INDEX_ATTRIBUTE), `index ${String(rowIndex)}`).toBe(
        false,
      );
    }
  });

  it("negative control: a row that holds a position still carries it", () => {
    // Without this the withholding above would also be satisfied by a component
    // that never wrote the attribute at all, which is a list no keyboard can move
    // through.
    const row = renderRow(<WindowedListRow as="li" rowIndex={3} totalRowCount={5} />);
    expect(row.getAttribute(WINDOWED_ROW_INDEX_ATTRIBUTE)).toBe("3");
  });
});
