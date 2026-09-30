// The wire reaches the store, and only through the one subscriber. Everything runs against the real
// fixture bridge playing the real concurrent-streaming scenario on the engine's frozen clock, since
// hand-written stand-ins for either end would pass over the gap this class closes (nothing called
// `SessionStoreRegistry.enqueue` or `daemon.subscribe`). Each case has a control that fails the way
// the regression would; the sharpest is the first, where without the subscriber the same advance
// reaches the registry not at all.

import { beforeEach, describe, expect, it } from "vitest";
import { withDaemonSubscribe } from "@test/helpers/fixture-bridge.js";
import { createFixtureBridge } from "../platform/platform-bridge.fixture.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../../../../fixtures/scenarios/concurrent-streaming.js";
import { APPLY_COALESCE_MS } from "@renderer/lib/reads/refresh-caps.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { windowTripwires } from "@renderer/lib/tripwires.js";
import { SessionStoreRegistry } from "@renderer/store/session/session-store-registry.js";
import { SessionEventSubscriber } from "./session-event-subscriber.js";
import {
  PAST_EVERY_BEAT_MS,
  SESSION_ID,
  createHarness,
} from "./session-event-subscriber.test-support.js";

const THROUGH_THIRD_BEAT_MS = CONCURRENT_STREAMING_SCENARIO.beats[2]?.atMs ?? 0;
const BEATS_THROUGH_THIRD_BEAT = CONCURRENT_STREAMING_SCENARIO.beats.filter(
  (beat) => beat.atMs <= THROUGH_THIRD_BEAT_MS,
).length;

// Tripwires throw in development; under test they are recorded, because these cases assert that a
// breach was detected and described.
beforeEach(() => {
  windowTripwires.setThrowOnReport(false);
  windowTripwires.reset();
});

describe("SessionEventSubscriber — the console's one subscription to the wire", () => {
  it("admits every beat of an open session to the apply chokepoint", () => {
    const { registry, binder, engine } = createHarness();
    binder.attach();
    registry.open(SESSION_ID);

    engine.advance(PAST_EVERY_BEAT_MS);

    expect(binder.appliedEventCountFor(SESSION_ID)).toBe(
      CONCURRENT_STREAMING_SCENARIO.beats.length,
    );
    expect(binder.boundSessionIds).toEqual([SESSION_ID]);
    expect(binder.droppedAfterCloseCount).toBe(0);
    expect(binder.unreadableDeliveryCount).toBe(0);

    // The count above is an admission count and moves before the queue drains; draining proves the
    // events reached the store's chokepoint.
    engine.advance(APPLY_COALESCE_MS + 1);
    expect(registry.applyDrainCountFor(SESSION_ID)).toBeGreaterThan(0);

    binder.dispose();
  });

  it("negative control: the same scenario reaches a registry with no binder not at all", () => {
    // The control for the case above: same registry, bridge and advance, but nothing subscribes.
    const { registry, engine } = createHarness();
    registry.open(SESSION_ID);

    engine.advance(PAST_EVERY_BEAT_MS);
    engine.advance(APPLY_COALESCE_MS + 1);

    expect(registry.applyDrainCountFor(SESSION_ID)).toBe(0);
    expect(registry.peek(SESSION_ID)?.snapshot().timeline).toEqual([]);
  });

  it("binds a session that was already open before it attached", () => {
    // The lost-open race in the order that loses it: the session is open before the subscriber
    // subscribes to the registry, so one listening only for changes would never hear of it.
    const { registry, binder, engine } = createHarness();
    registry.open(SESSION_ID);
    binder.attach();

    engine.advance(PAST_EVERY_BEAT_MS);

    expect(binder.boundSessionIds).toEqual([SESSION_ID]);
    expect(binder.appliedEventCountFor(SESSION_ID)).toBe(
      CONCURRENT_STREAMING_SCENARIO.beats.length,
    );

    binder.dispose();
  });

  it("stops delivering when the session closes, and freezes the count there", () => {
    const { registry, binder, engine } = createHarness();
    binder.attach();
    registry.open(SESSION_ID);

    engine.advance(THROUGH_THIRD_BEAT_MS);
    const countAtClose = binder.appliedEventCountFor(SESSION_ID);
    registry.close(SESSION_ID);
    engine.advance(PAST_EVERY_BEAT_MS);

    expect(countAtClose).toBe(BEATS_THROUGH_THIRD_BEAT);
    expect(binder.appliedEventCountFor(SESSION_ID)).toBe(countAtClose);
    expect(binder.boundSessionIds).toEqual([]);
    // The subscription is released, not merely ignored, or the wire would keep delivering into this
    // window.
    expect(engine.sinkCount).toBe(0);
    // Nothing raced, so nothing was dropped, which distinguishes this from the case below.
    expect(binder.droppedAfterCloseCount).toBe(0);

    binder.dispose();
  });

  it("drops a delivery that races a close, counts it, and reports it", () => {
    // Emission iterates a snapshot of the subscribers, so a listener that closes the session
    // mid-delivery leaves this handler in the batch still being delivered.
    const { registry, binder, engine } = createHarness();
    engine.subscribe(() => {
      registry.close(SESSION_ID);
    });
    binder.attach();
    registry.open(SESSION_ID);

    engine.advance(1);

    expect(binder.droppedAfterCloseCount).toBe(1);
    expect(binder.appliedEventCountFor(SESSION_ID)).toBe(0);
    expect(windowTripwires.firingCount("apply-chokepoint-bypass")).toBe(1);
    expect(windowTripwires.reports().at(-1)?.site).toBe("console/frame/session-event-binder.ts");

    binder.dispose();
  });

  it("negative control: a delivery to a session that is open reports nothing", () => {
    // Without this, the case above would pass on any tripwire firing, and the scenario engine
    // reports the same kind when a tick arrives after teardown.
    const { registry, binder, engine } = createHarness();
    binder.attach();
    registry.open(SESSION_ID);

    engine.advance(1);

    expect(binder.appliedEventCountFor(SESSION_ID)).toBe(1);
    expect(binder.droppedAfterCloseCount).toBe(0);
    expect(windowTripwires.totalFiringCount).toBe(0);

    binder.dispose();
  });

  it("releases every subscription on dispose, and disposes safely twice", () => {
    const { registry, binder, engine } = createHarness();
    binder.attach();
    registry.open(SESSION_ID);
    engine.advance(THROUGH_THIRD_BEAT_MS);
    const countAtDispose = binder.appliedEventCountFor(SESSION_ID);
    // Non-zero before the teardown, or "the count froze" would hold for a subscriber that never
    // delivered.
    expect(countAtDispose).toBe(BEATS_THROUGH_THIRD_BEAT);
    expect(engine.sinkCount).toBeGreaterThan(0);
    expect(registry.listenerCount).toBeGreaterThan(0);

    binder.dispose();
    binder.dispose();
    engine.advance(PAST_EVERY_BEAT_MS);

    expect(binder.isDisposed).toBe(true);
    expect(binder.boundSessionIds).toEqual([]);
    expect(binder.appliedEventCountFor(SESSION_ID)).toBe(countAtDispose);
    // Both subscriptions are gone: the wire's, and the registry's change feed.
    expect(engine.sinkCount).toBe(0);
    expect(registry.listenerCount).toBe(0);
    // A disposed subscriber cannot start again from a late effect.
    binder.attach();
    expect(registry.listenerCount).toBe(0);
  });

  it("hands out diagnostics that read its live state and keep the counts after dispose", () => {
    const { registry, binder, engine } = createHarness();
    // Taken before anything is bound, so a reading frozen at construction would fail below.
    const diagnostics = binder.diagnostics;
    expect(diagnostics.boundSessionIds()).toEqual([]);

    binder.attach();
    registry.open(SESSION_ID);
    engine.advance(PAST_EVERY_BEAT_MS);

    expect(diagnostics.openSessionIds()).toEqual([SESSION_ID]);
    expect(diagnostics.boundSessionIds()).toEqual([SESSION_ID]);
    expect(diagnostics.appliedEventCountFor(SESSION_ID)).toBe(
      CONCURRENT_STREAMING_SCENARIO.beats.length,
    );
    expect(diagnostics.appliedEventCountFor("session-nobody-opened")).toBe(0);

    binder.dispose();
    expect(diagnostics.boundSessionIds()).toEqual([]);
    expect(diagnostics.appliedEventCountFor(SESSION_ID)).toBe(
      CONCURRENT_STREAMING_SCENARIO.beats.length,
    );
  });

  it("asks for the base-state read in the same act as taking the subscription", async () => {
    // Nothing else called `requestRefresh` on an open, so even a registry with a working read never
    // performed one. The control is the count: zero without the request, with an empty timeline.
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
    const binder = new SessionEventSubscriber({ registry, bridge });
    binder.attach();
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
    expect(registry.peek(SESSION_ID)?.snapshot().timeline).toHaveLength(
      CONCURRENT_STREAMING_SCENARIO.beats.length,
    );

    binder.dispose();
  });

  it("harness integrity: the fixture engine drives the real frozen clock", () => {
    // The cases above measure coalescing windows in frozen milliseconds, which only means anything
    // on the manual clock; a real clock would make every advance a silent no-op.
    const { engine } = createHarness();
    expect(engine.clock).toBeInstanceOf(ManualClock);
  });
});

describe("SessionEventSubscriber — the request each stream is opened with", () => {
  /** A subscriber over the fixture bridge that keeps each request a stream was opened with. */
  function recordingRequests(): {
    readonly registry: SessionStoreRegistry;
    readonly binder: SessionEventSubscriber;
    readonly requests: unknown[];
  } {
    const { bridge: base, scenarioEngine: engine } = createFixtureBridge({
      scenario: CONCURRENT_STREAMING_SCENARIO,
    });
    const requests: unknown[] = [];
    const bridge = withDaemonSubscribe(base, (passThrough, _handler, request) => {
      requests.push(request);
      return passThrough();
    });
    const registry = new SessionStoreRegistry({
      read: () => Promise.resolve(undefined),
      clock: engine.clock,
    });
    return { registry, binder: new SessionEventSubscriber({ registry, bridge }), requests };
  }

  it("opens a session's stream scoped to that session", () => {
    const { registry, binder, requests } = recordingRequests();
    binder.attach();
    registry.open(SESSION_ID);

    expect(requests).toStrictEqual([{ sessionId: SESSION_ID }]);
    expect(binder.boundSessionIds).toEqual([SESSION_ID]);

    binder.dispose();
  });

  it("opens no stream for an id the daemon does not admit, and marks the session", () => {
    // A hand-typed route address reaches the registry as typed. The daemon would refuse it, so
    // nothing is opened or retried and the session shows the stream it does not have.
    const { registry, binder, requests } = recordingRequests();
    binder.attach();
    registry.open("not-a-session-id");

    expect(requests).toStrictEqual([]);
    expect(binder.boundSessionIds).toEqual([]);
    expect(binder.unboundSessionIds).toEqual([]);
    expect(registry.peek("not-a-session-id")?.snapshot().degradedCause).toBe("subscription-closed");

    binder.dispose();
  });
});
