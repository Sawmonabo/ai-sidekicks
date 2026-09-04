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
