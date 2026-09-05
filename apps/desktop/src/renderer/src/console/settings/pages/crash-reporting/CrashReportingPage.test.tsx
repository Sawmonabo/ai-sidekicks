// What the crash-reporting copy must say, and the two things it must not.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  fixtureBridgeWithGrowth,
  growthRefusing,
  unscriptedScenario,
} from "../../../bridge/fixture-bridge.test-support.js";
import { CrashReportingPage } from "./CrashReportingPage.js";
import type { ConsoleBridge } from "../../../bridge/index.js";

const SCENARIO = unscriptedScenario("crash-reporting-page-test");

/**
 * The shipped fixture bridge with the preference carrier refusing.
 *
 * The refusal is the port's own rather than a literal written out here, so the
 * "held in this window" arm this block renders is reached by the same value a
 * release build produces.
 */
function bridge(): ConsoleBridge {
  return fixtureBridgeWithGrowth(SCENARIO, {
    shellConfigRead: growthRefusing("shellConfigRead"),
    shellConfigWrite: growthRefusing("shellConfigWrite"),
  });
}

describe("crash reporting", () => {
  it("is on until somebody turns it off", () => {
    const { container } = render(<CrashReportingPage bridge={bridge()} />);
    expect(
      container.querySelector(".meridian-settings-row__switch")?.getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("names each thing that is stripped, and the three process kinds it covers", () => {
    const { container } = render(<CrashReportingPage bridge={bridge()} />);
    const text = container.textContent ?? "";
    expect(text).toContain("stable hashes");
    expect(text).toContain("reduced to their extension");
    expect(text).toContain("no content payloads");
    expect(text).toContain("main process");
    expect(text).toContain("child and utility processes");
  });

  it("negative control: it never calls a report anonymous and names no recipient", () => {
    // Both are claims the corpus does not make — the sink is unsettled, and a stable
    // hash is not anonymity. This fails the moment a comfortable sentence arrives.
    const { container } = render(<CrashReportingPage bridge={bridge()} />);
    const text = (container.textContent ?? "").toLowerCase();
    // The word appears exactly once, inside the sentence that DENIES the claim.
    expect(text).toContain("not the same as being anonymous");
    expect(text).not.toContain("is anonymous");
    expect(text).not.toContain("fully anonymous");
    expect(text).not.toContain("anonymised");
    expect(text).not.toContain("anonymized");
    expect(text).not.toContain("sent to");
  });
});
