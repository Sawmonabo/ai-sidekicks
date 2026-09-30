// What a caught render failure is RECORDED as.
//
// The boundary's other behaviors — the fallback card, the retry remount — are read
// off the screen by the browser and screenshot tiers. The claim that only a unit
// test can hold is the one about the diagnostic band: a region that threw while
// rendering mutated no store, so it must not land in the count that says a store
// was written outside its single `apply`. An operator reads those counts to decide
// what kind of defect they have, and a rendering bug reported as a state-write
// breach sends them at the wrong subsystem.
//
// Every case therefore asserts on TWO counts — the kind that should move and the
// kind that must not — and the apply-bypass count is deliberately non-zero before
// the crash, so "left at its prior count" is a comparison rather than a coincidence.

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
    // The registry throws in a development build, which a boundary reporting from
    // `componentDidCatch` would turn into a second failure inside React's own
    // error handling. The recording arm is the one under test here.
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
    // Without this, a boundary that reported on every mount would satisfy both
    // cases above and still be wrong.
    render(
      <ErrorBoundary regionName="The transcript">
        <CalmRegion />
      </ErrorBoundary>,
    );

    expect(windowTripwires.totalFiringCount).toBe(0);
  });
});
