// What a caught render failure is RECORDED as.
//
// The boundary's other behaviours — the fallback card, the retry remount — are read
// off the screen by the browser and screenshot tiers. The claim that only a unit
// test can hold is the one about the diagnostic band: a surface that threw while
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

import { reportTripwire } from "../core/index.js";
import { consoleTripwires } from "../core/tripwires.js";
import { SurfaceErrorBoundary } from "./ErrorBoundary.js";

const RENDER_FAILURE_MESSAGE = "the timeline could not render this row";

/** A surface that fails the way a real one does: during its own render. */
function ExplodingSurface(): React.JSX.Element {
  throw new Error(RENDER_FAILURE_MESSAGE);
}

function CalmSurface(): React.JSX.Element {
  return <p>the timeline rendered</p>;
}

describe("SurfaceErrorBoundary — a render crash is recorded as a render crash", () => {
  let restoreThrowOnReport = false;

  beforeEach(() => {
    // The registry throws in a development build, which a boundary reporting from
    // `componentDidCatch` would turn into a second failure inside React's own
    // error handling. The recording arm is the one under test here.
    restoreThrowOnReport = import.meta.env.DEV;
    consoleTripwires.setThrowOnReport(false);
    consoleTripwires.reset();
  });

  afterEach(() => {
    consoleTripwires.setThrowOnReport(restoreThrowOnReport);
    consoleTripwires.reset();
  });

  it("counts the failure under the render-failure kind and leaves the apply count alone", () => {
    reportTripwire(
      "apply-chokepoint-bypass",
      "console/primitives/ErrorBoundary.test.tsx",
      "a genuine store bypass, recorded before the crash",
    );
    const applyBypassBefore = consoleTripwires.firingCount("apply-chokepoint-bypass");

    render(
      <SurfaceErrorBoundary surfaceName="The timeline">
        <ExplodingSurface />
      </SurfaceErrorBoundary>,
    );

    expect(consoleTripwires.firingCount("surface-render-failure")).toBe(1);
    expect(consoleTripwires.firingCount("apply-chokepoint-bypass")).toBe(applyBypassBefore);
  });

  it("names the surface and carries the thrown message, so the record is actionable", () => {
    render(
      <SurfaceErrorBoundary surfaceName="The approvals pane">
        <ExplodingSurface />
      </SurfaceErrorBoundary>,
    );

    const report = consoleTripwires.reports().at(-1);
    expect(report?.kind).toBe("surface-render-failure");
    expect(report?.site).toBe("SurfaceErrorBoundary(The approvals pane)");
    expect(report?.detail).toContain(RENDER_FAILURE_MESSAGE);
  });

  it("negative control: a surface that renders reports nothing at all", () => {
    // Without this, a boundary that reported on every mount would satisfy both
    // cases above and still be wrong.
    render(
      <SurfaceErrorBoundary surfaceName="The timeline">
        <CalmSurface />
      </SurfaceErrorBoundary>,
    );

    expect(consoleTripwires.totalFiringCount).toBe(0);
  });
});
