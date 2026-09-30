// What a delivered payload must look like before it may reach a store. These cases drive the
// payload boundary (`services/daemon/session-event-payload.ts`), while the subscriber owns which
// sessions are bound. Each casts a deliberately wrong shape into a scenario beat, the way a daemon
// across a version skew would send it. The negative control is load-bearing: a boundary that
// refused every delivery would pass both refusals and look like a quiet session.

import { beforeEach, describe, expect, it } from "vitest";

import type { Scenario } from "../../../../../fixtures/scenario.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../../../../fixtures/scenarios/concurrent-streaming.js";
import { windowTripwires } from "@renderer/lib/tripwires.js";
import type { ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";
import { SESSION_ID, createHarness } from "./session-event-subscriber.test-support.js";

/** A scenario whose single beat delivers exactly the given payload at time zero. */
function scenarioDelivering(id: string, event: unknown): Scenario {
  return {
    ...CONCURRENT_STREAMING_SCENARIO,
    id,
    beats: [{ atMs: 0, event: event as ProjectedSessionEvent }],
  };
}

// Tripwires throw in development; under test they are recorded, because these cases assert that a
// breach was detected and described.
beforeEach(() => {
  windowTripwires.setThrowOnReport(false);
  windowTripwires.reset();
});

describe("SessionEventSubscriber — the payload boundary", () => {
  it("refuses a delivered payload that is not a session event, and counts it", () => {
    const { registry, binder, engine } = createHarness(
      scenarioDelivering("concurrent-streaming-malformed-payload-probe", { sequence: 1 }),
    );
    binder.attach();
    registry.open(SESSION_ID);

    engine.advance(1);

    expect(binder.unreadableDeliveryCount).toBe(1);
    expect(binder.appliedEventCountFor(SESSION_ID)).toBe(0);
    // Counted, not reported: an unfamiliar payload is a wire fact, not a console defect.
    expect(windowTripwires.totalFiringCount).toBe(0);

    binder.dispose();
  });

  it("refuses a delivery that carries every member but the canonical event id", () => {
    // The id keys a later read of the event's body, so a payload without one cannot be held.
    // Without this case the boundary could admit it, or compose an id from the present members,
    // and no other assertion here would differ.
    const { registry, binder, engine } = createHarness(
      scenarioDelivering("concurrent-streaming-idless-payload-probe", {
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "run.starting",
        occurredAt: "2026-01-01T14:20:00.400Z",
      }),
    );
    binder.attach();
    registry.open(SESSION_ID);

    engine.advance(1);

    expect(binder.unreadableDeliveryCount).toBe(1);
    expect(binder.appliedEventCountFor(SESSION_ID)).toBe(0);

    binder.dispose();
  });

  it("negative control: the same delivery carrying an id is admitted", () => {
    const { registry, binder, engine } = createHarness(
      scenarioDelivering("concurrent-streaming-idful-payload-probe", {
        id: "019b79ee-0280-7ea1-8110-e5e0d1150901",
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "run.starting",
        occurredAt: "2026-01-01T14:20:00.400Z",
      }),
    );
    binder.attach();
    registry.open(SESSION_ID);

    engine.advance(1);

    expect(binder.unreadableDeliveryCount).toBe(0);
    expect(binder.appliedEventCountFor(SESSION_ID)).toBe(1);

    binder.dispose();
  });
});
