// The fold: what a delivered frame does to what the pane knows.
//
// Split along the seam the module was. The two arms share one stream with no wire
// tag and are kept apart structurally — both registered schemas are strict, so each
// arm fails the other's parse — and a rewind is deliberately not folded as a
// transition, because it carries neither state and inventing one would put a
// transition in the history that never happened.

import { describe, expect, it } from "vitest";
import { RunStateProjection } from "./run-state-projection.js";
import {
  ENVELOPE_SHAPED_DELIVERY,
  ROLLED_BACK_DELIVERY,
  RUN_ID,
  STATE_CHANGE_DELIVERY,
} from "./run-state-feed.test-support.js";

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

/** A terminal transition carrying every piece of metadata a stop reports. */
const TERMINAL_DELIVERY = {
  runId: RUN_ID,
  runVersion: 5,
  previousState: "running",
  currentState: "completed",
  timestamp: "2026-09-02T09:05:00.000Z",
  trigger: "turn_limit",
  intendedClose: true,
  failureCategory: "provider failure",
  providerFailureDetail: "the provider closed the stream",
};

describe("a confirmed rewind re-opens the run", () => {
  it("reads the run as paused and clears the metadata of the epoch it undid", () => {
    // The rollback event is the operation's only state-stream notification, so a
    // fold that carried the terminal forward would leave the run looking finished
    // indefinitely and withhold every control the rewound run now has.
    const projection = new RunStateProjection();
    expect(projection.accept(TERMINAL_DELIVERY)).toBe(true);
    expect(projection.accept({ ...ROLLED_BACK_DELIVERY, runVersion: 6 })).toBe(true);
    const [run] = projection.runs();
    expect(run?.state).toBe("paused");
    expect(run?.trigger).toBeUndefined();
    expect(run?.intendedClose).toBe(false);
    expect(run?.failureCategory).toBeUndefined();
    expect(run?.providerFailureDetail).toBeUndefined();
  });

  it("appends one rewound row that carries neither state", () => {
    const projection = new RunStateProjection();
    projection.accept(TERMINAL_DELIVERY);
    projection.accept({ ...ROLLED_BACK_DELIVERY, runVersion: 6 });
    const [run] = projection.runs();
    expect(run?.statusRows).toHaveLength(2);
    const rewound = run?.statusRows.at(-1);
    expect(rewound?.subtype).toBe("rewound");
    expect(rewound?.previousState).toBeUndefined();
    expect(rewound?.currentState).toBeUndefined();
    // Both anchors are the event's own, and neither is derived from the held run.
    expect(rewound?.targetPosition).toBe(12);
    expect(run?.rewoundToPosition).toBe(12);
    expect(run?.runVersion).toBe(6);
  });

  it("negative control: that run reads completed with its metadata before the rewind", () => {
    // Without this the cases above would pass over a fold whose terminal never
    // landed, and would prove nothing about what the rewind cleared.
    const projection = new RunStateProjection();
    projection.accept(TERMINAL_DELIVERY);
    const [run] = projection.runs();
    expect(run?.state).toBe("completed");
    expect(run?.trigger).toBe("turn_limit");
    expect(run?.intendedClose).toBe(true);
    expect(run?.failureCategory).toBe("provider failure");
  });

  it("reads a run met through a rewind alone as paused, unchanged", () => {
    const projection = new RunStateProjection();
    expect(projection.accept(ROLLED_BACK_DELIVERY)).toBe(true);
    const [run] = projection.runs();
    expect(run?.state).toBe("paused");
    expect(run?.rewoundToPosition).toBe(12);
    expect(run?.statusRows).toHaveLength(1);
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
