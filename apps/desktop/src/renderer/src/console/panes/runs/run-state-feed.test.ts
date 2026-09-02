// What this feed will and will not read off `run.subscribeState`.
//
// The stream carries a registered WIRE PROJECTION — `RunStateChangeEvent` or
// `RunRolledBackEvent` — and never the whole-session event envelope the session
// stream carries. That is the seam's contract in the direction the bridge owes it:
// a fixture projects each beat into the registered payload shape, and this fold
// parses that shape and nothing else. Stating it as two cases rather than as a
// comment is the point of this file — the failure it guards against is silent in
// both directions. A fold that started reading envelopes would render rows from a
// shape the daemon does not send; a bridge that started sending envelopes would
// leave a live pane empty with nothing on screen saying why, which is why the
// refused delivery is COUNTED here rather than dropped.
//
// Driven through `RunStateProjection` directly rather than through the hook: the
// class is the whole parse, and mounting a component to reach it would put a React
// tree between the assertion and the rule it is asserting.

import { describe, expect, it } from "vitest";

import { RunStateProjection } from "./run-state-feed.js";

/** Canonical UUIDs: both registered schemas brand their ids and refuse anything else. */
const RUN_ID = "b3f0a1c2-4d5e-4f60-8a71-9c2d3e4f5061";
const SESSION_ID = "0a1b2c3d-4e5f-4061-8273-9a4b5c6d7e8f";

/** A transition, exactly as `RunStateChangeEventSchema` registers it. */
const STATE_CHANGE_DELIVERY = {
  runId: RUN_ID,
  runVersion: 3,
  previousState: "starting",
  currentState: "running",
  timestamp: "2026-09-02T09:00:00.000Z",
};

/** A rewind, exactly as `RunRolledBackEventSchema` registers it. */
const ROLLED_BACK_DELIVERY = {
  sessionId: SESSION_ID,
  runId: RUN_ID,
  runVersion: 4,
  targetPosition: 12,
};

/**
 * The whole-session envelope, wrapping the very same transition.
 *
 * The wrapper is the only difference from `STATE_CHANGE_DELIVERY`, which is what
 * makes the negative control below decisive: if the fold accepted this it would be
 * accepting the wrapper, not recovering the payload.
 */
const ENVELOPE_SHAPED_DELIVERY = {
  sessionId: SESSION_ID,
  sequence: 9,
  kind: "run.running",
  occurredAt: "2026-09-02T09:00:00.000Z",
  payload: STATE_CHANGE_DELIVERY,
};

describe("the run-state feed reads the registered payload shapes", () => {
  it("accepts a transition and folds it into the run's current reading", () => {
    const projection = new RunStateProjection();
    expect(projection.accept(STATE_CHANGE_DELIVERY)).toBe(true);
    expect(projection.runCount).toBe(1);
    expect(projection.unreadableDeliveryCount).toBe(0);
    const [run] = projection.runs();
    expect(run?.state).toBe("running");
    expect(run?.runVersion).toBe(3);
  });

  it("accepts a rewind and advances the position without inventing a transition", () => {
    const projection = new RunStateProjection();
    expect(projection.accept(ROLLED_BACK_DELIVERY)).toBe(true);
    const [run] = projection.runs();
    expect(run?.rewoundToPosition).toBe(12);
    expect(run?.statusRows.at(-1)?.currentState).toBeUndefined();
  });
});

describe("the run-state feed refuses the whole-session envelope", () => {
  it("reads no run from an envelope-shaped delivery and counts it unreadable", () => {
    const projection = new RunStateProjection();
    expect(projection.accept(ENVELOPE_SHAPED_DELIVERY)).toBe(false);
    expect(projection.runCount).toBe(0);
    expect(projection.unreadableDeliveryCount).toBe(1);
  });

  it("negative control: the envelope's own payload is accepted on its own", () => {
    // Without this the case above would pass over a fixture whose payload was
    // simply malformed, and would prove nothing about the wrapper.
    const projection = new RunStateProjection();
    expect(projection.accept(ENVELOPE_SHAPED_DELIVERY.payload)).toBe(true);
    expect(projection.runCount).toBe(1);
  });
});
