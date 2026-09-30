// A caught render failure is recorded under its own tripwire kind, not as a store-write breach.
//
// Each case asserts two counts, and the apply-bypass count starts non-zero so "left alone" is a
// real comparison.

import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reportTripwire } from "@renderer/lib/tripwires.js";
import { windowTripwires } from "@renderer/lib/tripwires.js";
import { ErrorBoundary } from "./ErrorBoundary.js";

const RENDER_FAILURE_MESSAGE = "the transcript could not render this row";

/** A region that fails the way a real one does: during its own render. */
function ExplodingRegion(): React.JSX.Element {
  throw new Error(RENDER_FAILURE_MESSAGE);
}

function CalmRegion(): React.JSX.Element {
  return <p>the transcript rendered</p>;
}

describe("ErrorBoundary — a render crash is recorded as a render crash", () => {
  let restoreThrowOnReport = false;

  beforeEach(() => {
    // The registry throws in a development build, which would fail inside React's own handling.
    restoreThrowOnReport = import.meta.env.DEV;
    windowTripwires.setThrowOnReport(false);
    windowTripwires.reset();
  });

  afterEach(() => {
    windowTripwires.setThrowOnReport(restoreThrowOnReport);
    windowTripwires.reset();
  });

  it("counts the failure under the render-failure kind and leaves the apply count alone", () => {
    reportTripwire(
      "apply-chokepoint-bypass",
      "components/ErrorBoundary/ErrorBoundary.test.tsx",
      "a genuine store bypass, recorded before the crash",
    );
    const applyBypassBefore = windowTripwires.firingCount("apply-chokepoint-bypass");

    render(
      <ErrorBoundary regionName="The transcript">
        <ExplodingRegion />
      </ErrorBoundary>,
    );

    expect(windowTripwires.firingCount("region-render-failure")).toBe(1);
    expect(windowTripwires.firingCount("apply-chokepoint-bypass")).toBe(applyBypassBefore);
  });

  it("names the region and carries the thrown message, so the record is actionable", () => {
    render(
      <ErrorBoundary regionName="The inspector">
        <ExplodingRegion />
      </ErrorBoundary>,
    );

    const report = windowTripwires.reports().at(-1);
    expect(report?.kind).toBe("region-render-failure");
    expect(report?.site).toBe("ErrorBoundary(The inspector)");
    expect(report?.detail).toContain(RENDER_FAILURE_MESSAGE);
  });

  it("negative control: a region that renders reports nothing at all", () => {
    // Catches a boundary that reports on every mount.
    render(
      <ErrorBoundary regionName="The transcript">
        <CalmRegion />
      </ErrorBoundary>,
    );

    expect(windowTripwires.totalFiringCount).toBe(0);
  });
});
