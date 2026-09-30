// The ARIA pair, and the one case where it would be a lie. The failure is the pair being absent,
// so the assertions check both members against the enumeration, not the mounted slice, and that an
// index which is not a position declares the set unknown.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WindowedListRow } from "./WindowedListRow.js";
import {
  WINDOWED_ROW_INDEX_ATTRIBUTE,
  WINDOWED_ROW_TARGET_ATTRIBUTE,
} from "@renderer/lib/windowed-row-markers.js";

/** The elements a browser puts in the sequential tab order without being asked. */
const NATIVELY_TABBABLE = "button, a[href], input, select, textarea";

/**
 * Every element inside `row` that Tab would reach, `row` itself included: a declared `tabindex`
 * decides, else the element's own kind. Counting `[tabindex="0"]` would miss a native second stop.
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
    // A row taking the mounted count would say "3 of 12" for row 3 of 4,000; the window-sized
    // answer must be a different string.
    const row = renderRow(<WindowedListRow as="li" rowIndex={2} totalRowCount={12} />);
    expect(row.getAttribute("aria-setsize")).toBe("12");
    expect(row.getAttribute("aria-setsize")).not.toBe("4000");
  });

  it("writes the index attribute the roving lookup reads", () => {
    // One seam: the reader declares the attribute, so the writer is asserted against its name.
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
    // A `feed`'s articles take the same two members as a grid row and a listbox option; asserted
    // through the component so the pair is still written.
    const row = renderRow(
      <WindowedListRow as="div" role="article" rowIndex={11} totalRowCount={2400} />,
    );

    expect(row.getAttribute("role")).toBe("article");
    expect(row.getAttribute("aria-setsize")).toBe("2400");
    expect(row.getAttribute("aria-posinset")).toBe("12");
  });

  it("negative control: a role the pair is not defined on stays rejected", () => {
    // Negative control: a role outside the set drops `aria-posinset`. Deleting the directive
    // surfaces the union error.
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
    // The roving effect focuses the element the row declared; a tab index with no marker, or two
    // markers, would leave that lookup guessing.
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
    // A scroll region that is one focus stop has no roving row; its controls keep native stops.
    const row = renderButtonRow({});
    expect(row.querySelector("button")?.hasAttribute("tabindex")).toBe(false);
    expect(sequentialTabStops(row).map((element) => element.tagName)).toStrictEqual(["BUTTON"]);
  });

  it("negative control: content passed as a node leaves the control a second stop", () => {
    // The roving index went on the wrapper while the button kept its native stop, giving the active
    // row two stops. Nothing written on the wrapper reaches a child passed as markup.
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
    // Negative control: an off-by-one refusing the tail of every enumeration would pass.
    const row = renderRow(<WindowedListRow as="li" rowIndex={4} totalRowCount={5} />);
    expect(row.getAttribute("aria-setsize")).toBe("5");
    expect(row.getAttribute("aria-posinset")).toBe("5");
  });

  it("withholds the index attribute the keyboard resolves against", () => {
    // The same rule for the index attribute: `rowElementAt` in `lib/windowed-row-markers.ts`
    // resolves `[data-index]` with `querySelector`, which takes the first match, so two
    // out-of-range rows would be one row.
    for (const rowIndex of [-1, 5, 1.5, Number.NaN]) {
      const row = renderRow(<WindowedListRow as="li" rowIndex={rowIndex} totalRowCount={5} />);
      expect(row.hasAttribute(WINDOWED_ROW_INDEX_ATTRIBUTE), `index ${String(rowIndex)}`).toBe(
        false,
      );
    }
  });

  it("negative control: a row that holds a position still carries it", () => {
    // Negative control: a component that never wrote the attribute would pass the case above.
    const row = renderRow(<WindowedListRow as="li" rowIndex={3} totalRowCount={5} />);
    expect(row.getAttribute(WINDOWED_ROW_INDEX_ATTRIBUTE)).toBe("3");
  });
});
