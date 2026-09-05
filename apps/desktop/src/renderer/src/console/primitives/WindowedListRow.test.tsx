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
import {
  WINDOWED_ROW_INDEX_ATTRIBUTE,
  WINDOWED_ROW_TARGET_ATTRIBUTE,
} from "./windowed-row-markers.js";

/** The elements a browser puts in the sequential tab order without being asked. */
const NATIVELY_TABBABLE = "button, a[href], input, select, textarea";

/**
 * Every element inside `row` that Tab would reach, `row` itself included.
 *
 * The platform's own rule rather than a proxy for it: a declared `tabindex` decides,
 * and where none is declared the element's own kind does. A count of `[tabindex="0"]`
 * would have reported the defect this file drives as one stop when it was two.
 */
function sequentialTabStops(row: HTMLElement): readonly HTMLElement[] {
  return [row, ...row.querySelectorAll<HTMLElement>("*")].filter((element) => {
    const declared = element.getAttribute("tabindex");
    return declared === null ? element.matches(NATIVELY_TABBABLE) : Number(declared) >= 0;
  });
}

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

  it("carries the pair on a feed's article, the third role the set admits", () => {
    // A chronological stream of long entries is a `feed`, whose articles take the
    // same two members a grid row and a listbox option do — which is the whole test
    // for membership in this set. Asserted through the component rather than by
    // reading its type, so what is checked is that the pair is still written.
    const row = renderRow(
      <WindowedListRow as="div" role="article" rowIndex={11} totalRowCount={2400} />,
    );

    expect(row.getAttribute("role")).toBe("article");
    expect(row.getAttribute("aria-setsize")).toBe("2400");
    expect(row.getAttribute("aria-posinset")).toBe("12");
  });

  it("negative control: a role the pair is not defined on stays rejected", () => {
    // Without this, "widen the set" would be satisfied by opening it to any string,
    // and a role that drops `aria-posinset` would render a claim nothing reads. The
    // directive is the assertion: deleting it surfaces the union error underneath.
    renderRow(
      // @ts-expect-error — `banner` is not one of the three roles the pair is
      // defined on, so it is not a role a windowed row may take.
      <WindowedListRow as="div" role="banner" rowIndex={0} totalRowCount={1} />,
    );
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

  it("marks the element that holds the stop, and marks exactly one", () => {
    // The roving effect focuses the element the row DECLARED. A row that wrote a tab
    // index and no marker, or two markers, would leave that lookup guessing — which
    // is the defect it used to guess its way into.
    const row = renderRow(<WindowedListRow as="li" rowIndex={0} totalRowCount={3} isTabbable />);
    expect(row.hasAttribute(WINDOWED_ROW_TARGET_ATTRIBUTE)).toBe(true);
    expect(row.querySelectorAll(`[${WINDOWED_ROW_TARGET_ATTRIBUTE}]`).length).toBe(0);
  });
});

describe("WindowedListRow — a row whose content is a control", () => {
  /** The console's real windowed row: a list item around one button. */
  function renderButtonRow(rovingState: { readonly isTabbable?: boolean }): HTMLElement {
    return renderRow(
      <WindowedListRow as="li" rowIndex={0} totalRowCount={3} {...rovingState}>
        {(targetProps) => (
          <button type="button" {...targetProps}>
            row 0
          </button>
        )}
      </WindowedListRow>,
    );
  }

  it("has exactly one tab stop, and it is the button", () => {
    const row = renderButtonRow({ isTabbable: true });
    const stops = sequentialTabStops(row);
    expect(stops.map((element) => element.tagName)).toStrictEqual(["BUTTON"]);
    expect(row.hasAttribute("tabindex")).toBe(false);
    expect(stops[0]?.getAttribute("tabindex")).toBe("0");
  });

  it("takes the control out of the tab order while its row is inactive", () => {
    const row = renderButtonRow({ isTabbable: false });
    expect(sequentialTabStops(row)).toStrictEqual([]);
    expect(row.querySelector("button")?.getAttribute("tabindex")).toBe("-1");
  });

  it("marks the control as the row's focus target, and the wrapper not at all", () => {
    const row = renderButtonRow({ isTabbable: true });
    expect(row.hasAttribute(WINDOWED_ROW_TARGET_ATTRIBUTE)).toBe(false);
    const marked = row.querySelectorAll(`[${WINDOWED_ROW_TARGET_ATTRIBUTE}]`);
    expect(marked.length).toBe(1);
    expect(marked[0]?.tagName).toBe("BUTTON");
  });

  it("leaves a control its native stop where the list is not a composite widget", () => {
    // A scroll region that is one focus stop of its own has no roving row, so its
    // controls are reached the way every other control on the page is.
    const row = renderButtonRow({});
    expect(row.querySelector("button")?.hasAttribute("tabindex")).toBe(false);
    expect(sequentialTabStops(row).map((element) => element.tagName)).toStrictEqual(["BUTTON"]);
  });

  it("negative control: content passed as a node leaves the control a second stop", () => {
    // The defect in terms, and the reason the delegating form exists: the roving index
    // went on the wrapper and the button kept its native stop, so the active row had
    // TWO stops and every mounted row was back in the page's tab order. Nothing this
    // component can write on the wrapper reaches a child it was handed as markup.
    const row = renderRow(
      <WindowedListRow as="li" rowIndex={0} totalRowCount={3} isTabbable>
        <button type="button">row 0</button>
      </WindowedListRow>,
    );
    expect(sequentialTabStops(row).map((element) => element.tagName)).toStrictEqual([
      "LI",
      "BUTTON",
    ]);
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
