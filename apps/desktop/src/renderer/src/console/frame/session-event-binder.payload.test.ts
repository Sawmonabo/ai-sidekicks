// What a delivered payload has to look like before it may reach a store.
//
// Split from `session-event-binder.test.ts` along the same seam the production code
// is split on: that module owns WHICH sessions are bound and for how long, and
// `bridge/daemon/session-event-payload.ts` owns WHAT a delivered payload has to look
// like. These cases drive the second question and nothing else.
//
// The wire hands the console an `unknown`. Each case below casts a deliberately wrong
// shape into a scenario beat, which is the only way to drive the boundary with what a
// daemon on the other side of a version skew would actually send. The negative control
// is load-bearing: a boundary that refused EVERY delivery would pass both refusals,
// and a console that admits nothing looks exactly like a quiet session.

import { beforeEach, describe, expect, it } from "vitest";

import type { ConsoleScenario } from "../bridge/scenario-runtime/scenario.js";
import { FLAGSHIP_SCENARIO } from "../bridge/scenarios/flagship.js";
import { consoleTripwires } from "../core/tripwires.js";
import type { ConsoleSessionEvent } from "../store/index.js";
import { SESSION_ID, createHarness } from "./session-event-binder.test-support.js";

/** A scenario whose single beat delivers exactly the given payload at time zero. */
function scenarioDelivering(id: string, event: unknown): ConsoleScenario {
  return {
    ...FLAGSHIP_SCENARIO,
    id,
    beats: [{ atMs: 0, event: event as ConsoleSessionEvent }],
  };
}

// Tripwires throw in development so a breach is impossible to ignore. Under test
// they are RECORDED instead, because these cases assert that a breach was detected
// and described — a throw would only prove it was noticed.
beforeEach(() => {
  consoleTripwires.setThrowOnReport(false);
  consoleTripwires.reset();
});

describe("SessionEventBinder — the payload boundary", () => {
  it("refuses a delivered payload that is not a session event, and counts it", () => {
    const { registry, binder, engine } = createHarness(
      scenarioDelivering("flagship-malformed-payload-probe", { sequence: 1 }),
    );
    binder.attach();
    registry.open(SESSION_ID);

    engine.advance(1);

    expect(binder.unreadableDeliveryCount).toBe(1);
    expect(binder.appliedEventCountFor(SESSION_ID)).toBe(0);
    // Counted, and deliberately not reported: an unfamiliar payload is a fact
    // about the wire, and a tripwire would name it a defect in the console.
    expect(consoleTripwires.totalFiringCount).toBe(0);

    binder.dispose();
  });

  it("refuses a delivery that carries every member but the canonical event id", () => {
    // The id is what a later read of this event's body is keyed by, so a payload
    // without one is not an envelope the console can hold. Without this case the
    // boundary could admit it and leave a row in the store that no surface could
    // ever open — and the alternative fix, composing an id from the members that
    // ARE present, would look identical from every other assertion in this file.
    const { registry, binder, engine } = createHarness(
      scenarioDelivering("flagship-idless-payload-probe", {
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
      scenarioDelivering("flagship-idful-payload-probe", {
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
