// The wire reaches the store, and only through the one subscriber. Everything runs against the real
// fixture bridge playing the real concurrent-streaming scenario on the engine's frozen clock, since
// hand-written stand-ins for either end would pass over the gap this class closes (nothing called
// `SessionStoreRegistry.enqueue` or `daemon.subscribe`).

import { beforeEach, describe, expect, it } from "vitest";
import { createFixtureBridge } from "../platform/platform-bridge.fixture.js";
import { CONCURRENT_STREAMING_SCENARIO } from "@fixtures/scenarios/concurrent-streaming.js";
import { APPLY_COALESCE_MS } from "@renderer/lib/reads/refresh-caps.js";
import { windowTripwires } from "@renderer/lib/tripwires.js";
import type { ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";
import { SessionStoreRegistry } from "@renderer/store/session/session-store-registry.js";
import { SessionEventSubscriber } from "./session-event-subscriber.js";
import {
  PAST_EVERY_BEAT_MS,
  SESSION_ID,
  createHarness,
} from "./session-event-subscriber.test-support.js";

// Tripwires throw in development; under test they are recorded, so a case can assert none fired.
beforeEach(() => {
  windowTripwires.setThrowOnReport(false);
  windowTripwires.reset();
});

describe("SessionEventSubscriber — the console's one subscription to the wire", () => {
  it("admits every beat of an open session to the apply chokepoint", () => {
    const { registry, subscriber, engine } = createHarness();
    subscriber.attach();
    registry.open(SESSION_ID);

    engine.advance(PAST_EVERY_BEAT_MS);

    expect(subscriber.appliedEventCountFor(SESSION_ID)).toBe(
      CONCURRENT_STREAMING_SCENARIO.beats.length,
    );
    expect(subscriber.boundSessionIds).toEqual([SESSION_ID]);
    expect(subscriber.droppedAfterCloseCount).toBe(0);
    expect(subscriber.unreadableDeliveryCount).toBe(0);

    // The count above is an admission count and moves before the queue drains; draining proves the
    // events reached the store's chokepoint.
    engine.advance(APPLY_COALESCE_MS + 1);
    expect(registry.applyDrainCountFor(SESSION_ID)).toBeGreaterThan(0);

    subscriber.dispose();
  });

  it("binds a session that was already open before it attached", () => {
    // The lost-open race in the order that loses it: the session is open before the subscriber
    // subscribes to the registry, so one listening only for changes would never hear of it.
    const { registry, subscriber, engine } = createHarness();
    registry.open(SESSION_ID);
    subscriber.attach();

    engine.advance(PAST_EVERY_BEAT_MS);

    expect(subscriber.boundSessionIds).toEqual([SESSION_ID]);
    expect(subscriber.appliedEventCountFor(SESSION_ID)).toBe(
      CONCURRENT_STREAMING_SCENARIO.beats.length,
    );

    subscriber.dispose();
  });

  it("asks for the base-state read in the same act as taking the subscription", async () => {
    // Nothing else called `requestRefresh` on an open, so even a registry with a working read never
    // performed one. The control is the count: zero without the request, with an empty transcript.
    const { bridge, scenarioEngine: engine } = createFixtureBridge({
      scenario: CONCURRENT_STREAMING_SCENARIO,
    });
    const reasonsSeen: string[] = [];
    const registry = new SessionStoreRegistry({
      read: (_sessionId, reasons) => {
        reasonsSeen.push(...reasons);
        return Promise.resolve({ cursor: 0, entities: [] });
      },
      clock: engine.clock,
      refreshDebounceMs: 0,
    });
    const subscriber = new SessionEventSubscriber({ registry, bridge });
    subscriber.attach();
    registry.open(SESSION_ID);

    // The scheduler debounces on the frozen clock, so the read lands on an advance, not a
    // microtask turn.
    engine.advance(1);
    await Promise.resolve();

    expect(reasonsSeen).toEqual(["subscribe"]);
    expect(registry.refreshCountFor(SESSION_ID)).toBe(1);
    expect(registry.peek(SESSION_ID)?.snapshot().initialized).toBe(true);

    engine.advance(PAST_EVERY_BEAT_MS);
    engine.advance(APPLY_COALESCE_MS + 1);
    expect(registry.peek(SESSION_ID)?.snapshot().transcript).toHaveLength(
      CONCURRENT_STREAMING_SCENARIO.beats.length,
    );

    subscriber.dispose();
  });

  it("refuses a delivered payload that is not a session event, and counts it", () => {
    const { registry, subscriber, engine } = createHarness({
      ...CONCURRENT_STREAMING_SCENARIO,
      id: "concurrent-streaming-malformed-payload-probe",
      beats: [{ atMs: 0, event: { sequence: 1 } as unknown as ProjectedSessionEvent }],
    });
    subscriber.attach();
    registry.open(SESSION_ID);

    engine.advance(1);

    expect(subscriber.unreadableDeliveryCount).toBe(1);
    expect(subscriber.appliedEventCountFor(SESSION_ID)).toBe(0);
    // Counted, not reported: an unfamiliar payload is a wire fact, not a console defect.
    expect(windowTripwires.totalFiringCount).toBe(0);

    subscriber.dispose();
  });
});
