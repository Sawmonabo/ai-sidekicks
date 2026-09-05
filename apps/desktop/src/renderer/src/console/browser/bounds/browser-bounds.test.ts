// The browser's bounds block, held to what 12.10 claims about it.
//
// A constants module looks untestable — the value IS the assertion — and that
// reading is what lets a bound drift into a value its comment no longer describes.
// The checkable content here is not the numbers but the DECLARATION: that the table
// is total over the declared set, that the payload ceilings are the contract's own
// constant rather than a copy of its digits, and that a ceiling this console does not
// set names its owner. None of those is about what `BudgetMeter.tsx` puts on screen,
// which is why they are asserted here rather than through a render.

import { CONTENT_PAYLOAD_PLAINTEXT_MAX } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { BROWSER_BOUNDS, BROWSER_BOUND_NAMES } from "./browser-bounds.js";

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
