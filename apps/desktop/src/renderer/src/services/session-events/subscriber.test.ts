// The wire reaches the store, and only through the one subscriber. Everything runs against the real
// fixture bridge playing the real concurrent-streaming scenario on the engine's frozen clock, since
// hand-written stand-ins for either end would pass over the gap this class closes (nothing called
// `SessionStoreRegistry.enqueue` or `daemon.subscribe`).

import { beforeEach, describe, expect, it } from "vitest";
import { createFixtureBridge } from "../platform/bridge.fixture.js";
import type { SessionReadResponse } from "@ai-sidekicks/contracts/session/methods";

import { CONCURRENT_STREAMING_SCENARIO } from "#fixtures/scenarios/concurrent-streaming.js";
import { TRANSCRIPT_STATES_SCENARIO } from "#fixtures/scenarios/transcript-states.js";
import {
  lastScriptedBeatMs,
  withDaemonCall,
  withDaemonSubscribe,
} from "#test/helpers/fixture/bridge.js";
import { sessionReadThroughDaemon } from "../daemon/session/read/base-state.js";
import { windowTripwires } from "#renderer/lib/tripwires/registry.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { SessionStoreRegistry } from "#renderer/store/session/registry.js";
import {
  OPENING_PAGE_LIMIT,
  openingPageLimit,
  offScreenRowLimit,
} from "#test/helpers/session/store/fixtures.js";
import { SessionEventSubscriber } from "./subscriber.js";
import {
  PAST_EVERY_BEAT_MS,
  SESSION_ID,
  createHarness,
  landReads,
} from "./subscriber.test-support.js";

// Tripwires throw in development; under test they are recorded, so a case can assert none fired.
beforeEach(() => {
  windowTripwires.setThrowOnReport(false);
  windowTripwires.reset();
});

describe("SessionEventSubscriber — the console's one subscription to the wire", () => {
  it("admits every beat of an open session to the apply chokepoint", async () => {
    const { registry, subscriber, engine } = createHarness();
    subscriber.attach();
    registry.open(SESSION_ID);
    await landReads(engine);

    engine.advance(PAST_EVERY_BEAT_MS);

    expect(subscriber.appliedEventCountFor(SESSION_ID)).toBe(
      CONCURRENT_STREAMING_SCENARIO.beats.length,
    );
    expect(subscriber.boundSessionIds).toEqual([SESSION_ID]);
    expect(subscriber.droppedAfterCloseCount).toBe(0);
    expect(subscriber.unreadableDeliveryCount).toBe(0);

    // The count above is an admission count and moves before the queue drains; draining proves the
    // events reached the store's chokepoint.
    engine.runFrame();
    expect(registry.applyDrainCountFor(SESSION_ID)).toBeGreaterThan(0);

    subscriber.dispose();
  });

  it("binds a session that was already open before it attached", async () => {
    // The lost-open race in the order that loses it: the session is open before the subscriber
    // subscribes to the registry, so one listening only for changes would never hear of it.
    const { registry, subscriber, engine } = createHarness();
    registry.open(SESSION_ID);
    subscriber.attach();
    await landReads(engine);

    engine.advance(PAST_EVERY_BEAT_MS);

    expect(subscriber.boundSessionIds).toEqual([SESSION_ID]);
    expect(subscriber.appliedEventCountFor(SESSION_ID)).toBe(
      CONCURRENT_STREAMING_SCENARIO.beats.length,
    );

    subscriber.dispose();
  });

  it("reads an opened session first and opens its stream once that read lands", async () => {
    // Nothing else calls `requestRefresh` on an open, so without it no read is performed and no
    // stream opens. The control is the count: zero without the request, with an empty transcript.
    const { bridge, scenarioEngine: engine } = createFixtureBridge({
      scenario: CONCURRENT_STREAMING_SCENARIO,
    });
    const reasonsSeen: string[] = [];
    const registry = new SessionStoreRegistry({
      read: (_sessionId, reasons) => {
        reasonsSeen.push(...reasons);
        return Promise.resolve({ entities: [] });
      },
      clock: engine.clock,
      openingPageLimit,
      offScreenRowLimit,
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
    engine.runFrame();
    expect(registry.peek(SESSION_ID)?.snapshot().transcript).toHaveLength(
      CONCURRENT_STREAMING_SCENARIO.beats.length,
    );

    subscriber.dispose();
  });

  it("opens the window at the acknowledged position and the stream after it", async () => {
    // Every beat has fallen due before the session opens, so the acknowledged row is in the log.
    const { bridge: base, scenarioEngine: engine } = createFixtureBridge({
      scenario: TRANSCRIPT_STATES_SCENARIO,
    });
    engine.advance(lastScriptedBeatMs(TRANSCRIPT_STATES_SCENARIO) + 1);
    let acknowledged: string | undefined;
    const { bridge: reading, calls } = withDaemonCall(base, async (call, passThrough) => {
      const reply = await passThrough();
      if (call.method === "session.read") {
        acknowledged = (reply as SessionReadResponse).transcriptCursors.acknowledged;
      }
      return reply;
    });
    const opens: unknown[] = [];
    const bridge = withDaemonSubscribe(reading, (passThrough, _handler, request) => {
      opens.push(request);
      return passThrough();
    });
    const sessionId = TRANSCRIPT_STATES_SCENARIO.sessionId;
    const registry = new SessionStoreRegistry({
      read: sessionReadThroughDaemon(bridge),
      clock: engine.clock,
      openingPageLimit,
      offScreenRowLimit,
      refreshDebounceMs: 0,
    });
    const subscriber = new SessionEventSubscriber({ registry, bridge, clock: engine.clock });
    subscriber.attach();
    registry.open(sessionId);
    await landReads(engine);
    engine.runFrame();

    expect(acknowledged).toBeDefined();
    expect(calls.find((call) => call.method === "transcript.read")?.params).toMatchObject({
      beforeCursor: acknowledged,
      limit: OPENING_PAGE_LIMIT,
    });
    expect(opens).toEqual([{ sessionId, afterCursor: acknowledged }]);
    // The window ends at the acknowledged row and the stream sends every row after it, so the
    // store holds the whole log, which is shorter than one page, once.
    const store = registry.peek(sessionId)?.snapshot();
    expect(store?.transcriptHead.hasMore).toBe(false);
    expect(store?.transcript.map((event) => event.sequence)).toEqual(
      TRANSCRIPT_STATES_SCENARIO.beats.map((beat) => beat.event.sequence),
    );
    expect(store?.gaps).toEqual([]);

    subscriber.dispose();
  });

  it("refuses a delivered payload that is not a session event, and counts it", async () => {
    const { registry, subscriber, engine } = createHarness({
      ...CONCURRENT_STREAMING_SCENARIO,
      id: "concurrent-streaming-malformed-payload-probe",
      beats: [{ atMs: 0, event: { sequence: 1 } as unknown as ProjectedSessionEvent }],
    });
    subscriber.attach();
    registry.open(SESSION_ID);
    await landReads(engine);

    engine.advance(1);

    expect(subscriber.unreadableDeliveryCount).toBe(1);
    expect(subscriber.appliedEventCountFor(SESSION_ID)).toBe(0);
    // Counted, not reported: an unfamiliar payload is a wire fact, not a console defect.
    expect(windowTripwires.totalFiringCount).toBe(0);

    subscriber.dispose();
  });
});
