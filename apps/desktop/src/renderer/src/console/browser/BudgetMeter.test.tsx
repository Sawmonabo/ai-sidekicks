// The bounds block of 12.10, and the meter that renders it.
//
// The failure this surface exists to prevent is a resource ceiling that is written
// down in a design document and nowhere in the product. So the assertions are about
// the two things that make it real: the table is complete against the declared bound
// set, and an unmeasured ceiling says "not measured" rather than a plausible zero —
// an operator reading a false 0 concludes the pane is idle when it may be at its cap.

import { render, screen, within } from "@testing-library/react";
import { CONTENT_PAYLOAD_PLAINTEXT_MAX } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { BROWSER_BOUNDS, BROWSER_BOUND_NAMES, BudgetMeter } from "./BudgetMeter.js";

describe("BROWSER_BOUNDS", () => {
  it("carries every declared bound, exactly once, with a derivation for each", () => {
    expect(new Set(BROWSER_BOUND_NAMES).size).toBe(BROWSER_BOUND_NAMES.length);
    for (const name of BROWSER_BOUND_NAMES) {
      expect(BROWSER_BOUNDS[name].derivation.length).toBeGreaterThan(0);
    }
    expect(Object.keys(BROWSER_BOUNDS)).toHaveLength(BROWSER_BOUND_NAMES.length);
  });

  it("takes the three payload ceilings from the contract rather than restating them", () => {
    // A locally typed 262144 would be a second copy of a number the daemon enforces,
    // and it would still read as correct on the day the contract moved.
    for (const name of [
      "SNAPSHOT_TEXT_MAX",
      "EVALUATE_RESULT_MAX",
      "LOCATOR_RESULT_MAX",
    ] as const) {
      const measure = BROWSER_BOUNDS[name].measure;
      expect(measure.kind).toBe("scalar");
      if (measure.kind !== "scalar") {
        throw new Error("unreachable");
      }
      expect(measure.value).toBe(CONTENT_PAYLOAD_PLAINTEXT_MAX);
    }
  });

  it("names an owner for every ceiling it does not itself set", () => {
    for (const name of BROWSER_BOUND_NAMES) {
      const measure = BROWSER_BOUNDS[name].measure;
      if (measure.kind === "deferred") {
        expect(measure.owner.length).toBeGreaterThan(0);
      }
    }
  });
});

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
