// One stream, two frames, and a reader that tells them apart — including the frame
// that is neither, which is what the consumer counts as an unreadable delivery.

import { describe, expect, it } from "vitest";

import { readRunRolledBack, readRunStateChange } from "./run-state-events.js";

const RUN_ID = "b3f0a1c2-4d5e-4f60-8a71-9c2d3e4f5061";

/** A transition, in the shape `run.subscribeState` registers for one. */
const TRANSITION = {
  runId: RUN_ID,
  runVersion: 3,
  previousState: "starting",
  currentState: "running",
  timestamp: "2026-09-02T09:00:00.000Z",
};

describe("the run-state frame readers", () => {
  it("reads a transition and does not read it as a rewind", () => {
    expect(readRunStateChange(TRANSITION)?.runId).toBe(RUN_ID);
    // The two frames travel one stream, so a reader that admitted both would let a
    // consumer fold a transition through the rewind arm.
    expect(readRunRolledBack(TRANSITION)).toBeUndefined();
  });

  it("refuses a frame that is neither", () => {
    // The unreadable-delivery case: the consumer counts this and says so beside the
    // rows, which it cannot do if a reader answers a half-understood value.
    expect(readRunStateChange({ runId: RUN_ID })).toBeUndefined();
    expect(readRunRolledBack({ runId: RUN_ID })).toBeUndefined();
  });
});
