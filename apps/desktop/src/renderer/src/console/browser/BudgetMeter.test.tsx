// The meter that renders 12.10's bounds block.
//
// The failure this surface exists to prevent is a resource ceiling that is written
// down in a design document and nowhere in the product, so the assertions here are
// about what reaches the screen: a row per declared bound, and an unmeasured ceiling
// saying "not measured" rather than a plausible zero — an operator reading a false 0
// concludes the pane is idle when it may be at its cap.
//
// The BLOCK's own claims — that it is total over the declared set, that the payload
// ceilings are the contract's constant rather than a copy of its digits, and that a
// deferred ceiling names its owner — moved with the block to
// `core/constants.test.ts`, which is where the numbers now live.

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BROWSER_BOUNDS, BROWSER_BOUND_NAMES } from "../core/index.js";
import { formatByteQuantity } from "../primitives/index.js";
import { BudgetMeter } from "./BudgetMeter.js";

describe("BudgetMeter", () => {
  it("renders one row per bound, headed and scoped for a screen reader", () => {
    render(<BudgetMeter />);
    const table = screen.getByRole("table");
    for (const name of BROWSER_BOUND_NAMES) {
      expect(within(table).getByRole("rowheader", { name })).toBeTruthy();
    }
    expect(within(table).getAllByRole("columnheader")).toHaveLength(4);
  });

  it("says a ceiling is not measured rather than reporting a zero nobody counted", () => {
    render(<BudgetMeter />);
    expect(screen.getAllByText("Not measured").length).toBe(BROWSER_BOUND_NAMES.length);
  });

  it("reports a reading it was given", () => {
    render(<BudgetMeter readings={{ VIEWS_MAX: 2 }} />);
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getAllByText("Not measured").length).toBe(BROWSER_BOUND_NAMES.length - 1);
  });

  it("marks a reading that has reached its ceiling, and only then", () => {
    const viewsCeiling = BROWSER_BOUNDS.VIEWS_MAX.measure;
    if (viewsCeiling.kind !== "scalar") {
      throw new Error("VIEWS_MAX is expected to be a scalar ceiling");
    }
    const { unmount } = render(<BudgetMeter readings={{ VIEWS_MAX: viewsCeiling.value }} />);
    expect(screen.getByText("at the ceiling")).toBeTruthy();
    unmount();

    // The control: one below the ceiling is not marked. Without it, a meter that
    // flagged every row would satisfy the assertion above.
    render(<BudgetMeter readings={{ VIEWS_MAX: viewsCeiling.value - 1 }} />);
    expect(screen.queryByText("at the ceiling")).toBeNull();
  });

  it("does not invent a reading for a ceiling that is not a single number", () => {
    // `VIEWPORT_DEFAULT` is a pixel box and the capture ceiling is somebody else's;
    // a scalar reading against either would be a comparison of unlike things.
    render(<BudgetMeter readings={{ VIEWPORT_DEFAULT: 5, CAPTURE_AND_DOWNLOAD_BYTES: 5 }} />);
    expect(screen.queryByText("5")).toBeNull();
  });
});

describe("BudgetMeter — a byte ceiling renders through the byte chokepoint", () => {
  /**
   * A byte quantity as the DOM reports it back.
   *
   * `formatByteQuantity` joins the figure to its unit with a no-break space so the
   * two can never wrap apart; testing-library normalises that to an ordinary space
   * in the element's text and does not normalise the matcher, so a raw comparison
   * misses every byte figure on the page.
   */
  function renderedByteText(byteCount: number): string {
    return formatByteQuantity(byteCount).text.replace("\u00A0", " ");
  }

  /** One declared bound's scalar measure, or a failure naming the row. */
  function scalarMeasureOf(name: (typeof BROWSER_BOUND_NAMES)[number]): {
    readonly value: number;
    readonly unit: string;
  } {
    const measure = BROWSER_BOUNDS[name].measure;
    if (measure.kind !== "scalar") {
      throw new Error(`${name} is expected to be a scalar ceiling`);
    }
    return measure;
  }

  it("scales every bytes-valued ceiling into binary units", () => {
    render(<BudgetMeter />);
    // The three the finding named, plus the fourth that shares their derivation. A
    // raw `262144` on screen is the decimal-byte text this dispatch exists to stop.
    for (const name of [
      "SNAPSHOT_TEXT_MAX",
      "EVALUATE_RESULT_MAX",
      "LOCATOR_RESULT_MAX",
      "CLIPBOARD_MAX",
    ] as const) {
      const measure = scalarMeasureOf(name);
      expect(measure.unit).toBe("bytes");
      const scaled = renderedByteText(measure.value);
      const row = screen.getByRole("rowheader", { name }).closest("tr");
      expect(row).not.toBeNull();
      expect(within(row as HTMLTableRowElement).getByText(scaled)).toBeTruthy();
      expect(within(row as HTMLTableRowElement).queryByText(String(measure.value))).toBeNull();
    }
  });

  it("keeps the words a byte unit still says after the scaling", () => {
    render(<BudgetMeter />);
    const measure = scalarMeasureOf("CONSOLE_ENTRY_MAX");
    expect(measure.unit).toBe("bytes per entry");
    const row = screen.getByRole("rowheader", { name: "CONSOLE_ENTRY_MAX" }).closest("tr");
    expect(row).not.toBeNull();
    expect(
      within(row as HTMLTableRowElement).getByText(`${renderedByteText(measure.value)} per entry`),
    ).toBeTruthy();
  });

  it("keeps the exact byte on the figure that was scaled", () => {
    // The scaled figure is rounded to one fraction digit, so the byte a refusal
    // would name is no longer in the text. It has to stay readable somewhere.
    render(<BudgetMeter />);
    const measure = scalarMeasureOf("CLIPBOARD_MAX");
    const row = screen.getByRole("rowheader", { name: "CLIPBOARD_MAX" }).closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLTableRowElement).getByTitle(String(measure.value))).toBeTruthy();
  });

  it("negative control: a counted ceiling is not scaled and carries its unit as a word", () => {
    // Without this, a meter that sent EVERY figure through the byte formatter would
    // satisfy the assertions above while rendering "8 B" where the ceiling is eight
    // pages — and no title would be owed there either.
    render(<BudgetMeter />);
    const measure = scalarMeasureOf("PAGES_PER_RUN_MAX");
    expect(measure.unit).toBe("pages");
    const row = screen.getByRole("rowheader", { name: "PAGES_PER_RUN_MAX" }).closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLTableRowElement).getByText("8 pages")).toBeTruthy();
    expect(within(row as HTMLTableRowElement).queryByTitle("8")).toBeNull();
  });

  it("reports a live byte reading in the same units as the ceiling beside it", () => {
    // The two columns are read against each other, so a reading left in decimal
    // bytes beside a scaled ceiling invites the comparison that is wrong.
    render(<BudgetMeter readings={{ CLIPBOARD_MAX: 1_048_576 }} />);
    expect(screen.getByText(renderedByteText(1_048_576))).toBeTruthy();
    expect(screen.queryByText("1,048,576")).toBeNull();
  });
});
