// A reading of one run is never shown as a reading of another.
//
// The defect this file pins is a single committed frame. The run projection names a
// newer run, the component re-renders with the new id, and the effect that leases
// that run's read has not run yet — so an unstamped hold renders the new run's
// heading over the previous run's child links and refusals. After `act` flushes the
// effect the frame is gone, which is exactly why the rule is a pure function here
// and is driven directly: a DOM assertion taken after the flush would pass over the
// old code as readily as over the new one.
//
// The component cases below cover what survives the flush — that a run with no read
// yet renders the not-checked absence, and that a settled read renders under the run
// it was acquired for.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ChildRunLinkageRead } from "../run-console/agent-console-reads.js";
import { RunLinkageMount } from "./RunLinkageMount.js";
import { linkageReadFor, type AcquiredLinkage } from "./ResolvedRunLinkage.js";

const FIRST_RUN_ID = "run-7";
const SECOND_RUN_ID = "run-9";

/**
 * An acquisition whose read is identifiable and whose run is stated.
 *
 * The read is a marker rather than a real `ChildRunLinkageRead`: the rule under test
 * compares run ids and never touches the read, so building a live one would add a
 * bridge, a scheduler, and a subscription to a comparison that has none.
 */
function acquisitionFor(parentRunId: string): AcquiredLinkage {
  return { parentRunId, read: { parentRunId } as unknown as ChildRunLinkageRead };
}

/** The rule the stamp replaced: whatever is held, whichever run is current. */
function unstampedLinkageRead(
  acquired: AcquiredLinkage | undefined,
  _parentRunId: string,
): ChildRunLinkageRead | undefined {
  return acquired?.read;
}

describe("the run linkage's held read — which run it answers for", () => {
  it("renders the read acquired for the run on screen", () => {
    const acquired = acquisitionFor(FIRST_RUN_ID);
    expect(linkageReadFor(acquired, FIRST_RUN_ID)).toBe(acquired.read);
  });

  it("renders nothing while the held read is the previous run's", () => {
    // The frame the finding named: the projection has moved to the second run and
    // the effect that re-leases has not run, so the hold is still the first run's.
    const acquired = acquisitionFor(FIRST_RUN_ID);
    expect(linkageReadFor(acquired, SECOND_RUN_ID)).toBeUndefined();
  });

  it("renders nothing before anything has been acquired at all", () => {
    expect(linkageReadFor(undefined, FIRST_RUN_ID)).toBeUndefined();
  });

  it("negative control: the unstamped rule serves the previous run's read", () => {
    // Same inputs, the rule this replaced. Without this the case above would hold
    // for any function that returned `undefined` more often than it should.
    const acquired = acquisitionFor(FIRST_RUN_ID);
    expect(unstampedLinkageRead(acquired, SECOND_RUN_ID)).toBe(acquired.read);
    expect(unstampedLinkageRead(acquired, FIRST_RUN_ID)).toBe(acquired.read);
  });
});

describe("the run linkage mount — what it renders without a subject", () => {
  it("says nothing was asked when the mount resolved no models", () => {
    render(<RunLinkageMount models={undefined} sessionStore={undefined} agentId="agent-scout" />);

    expect(screen.getByText("No run of this agent is on the timeline yet.")).toBeInstanceOf(
      HTMLElement,
    );
  });
});
