// A frame carrying the daemon's drop mark, and the repair it asks for.
//
// The daemon never waits for a slow screen: when it drops changes for a connection,
// the next frame that fits carries the mark, and a connection that caught up with
// nothing new to send is handed one frame with no changes and the mark. No scenario
// plays either — the fixture never falls behind — so each case hands the subscriber
// the frame itself, through the real fixture bridge's subscribe arm.

import { beforeEach, describe, expect, it } from "vitest";

import { createFixtureBridge } from "../platform/platform-bridge.fixture.js";
import {
  composeScenarioSessionFrames,
  type ScenarioSessionStreamFrame,
} from "../daemon/event-envelope.fixture.js";
import { withDaemonSubscribe } from "@test/helpers/fixture-bridge.js";
import { settleMicrotasks } from "@test/helpers/session-store-fixtures.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../../../../fixtures/scenarios/concurrent-streaming.js";
import { windowTripwires } from "@renderer/lib/tripwires.js";
import type { RefreshReason } from "@renderer/lib/reads/refresh-scheduler.js";
import type { ScenarioEngine } from "../daemon/engine.fixture.js";
import { SessionStoreRegistry } from "@renderer/store/session/session-store-registry.js";
import { SessionEventSubscriber } from "./session-event-subscriber.js";
import { SESSION_ID } from "./session-event-subscriber.test-support.js";

/** A subscriber whose session stream the case feeds, and the reads its registry performed. */
interface DropHarness {
  readonly registry: SessionStoreRegistry;
  readonly binder: SessionEventSubscriber;
  readonly engine: ScenarioEngine;
  /** Hands the bound session's subscription one delivered frame. */
  readonly deliver: (frame: unknown) => void;
  /** Every reason the registry's read was performed for, in order. */
  readonly reasonsSeen: RefreshReason[];
}

/**
 * The subscriber over the fixture bridge, its session bound and its opening read done.
 *
 * The subscription is opened through to the scenario as it ships, and its handler is
 * kept so a case can hand it a frame no scenario plays. The opening `subscribe` read
 * is spent before the case starts, so the reasons a case sees are the ones its frame
 * asked for.
 */
async function createBoundHarness(): Promise<DropHarness> {
  // The concurrent-streaming session with no beats of its own, so every event the
  // subscriber sees is one the case handed it.
  const { bridge: base, scenarioEngine: engine } = createFixtureBridge({
    scenario: { ...CONCURRENT_STREAMING_SCENARIO, id: "drop-mark-probe", beats: [] },
  });
  const handlers: ((frame: unknown) => void)[] = [];
  const bridge = withDaemonSubscribe(base, (passThrough, handler) => {
    handlers.push(handler);
    return passThrough();
  });
  const reasonsSeen: RefreshReason[] = [];
  const registry = new SessionStoreRegistry({
    read: (_sessionId, reasons) => {
      reasonsSeen.push(...reasons);
      return Promise.resolve(undefined);
    },
    clock: engine.clock,
    refreshDebounceMs: 0,
  });
  const binder = new SessionEventSubscriber({ registry, bridge });
  binder.attach();
  registry.open(SESSION_ID);
  engine.advance(0);
  await settleMicrotasks();
  expect(reasonsSeen).toEqual(["subscribe"]);
  reasonsSeen.length = 0;
  const [handler] = handlers;
  if (handler === undefined) {
    throw new Error("the subscriber opened no stream for the session");
  }
  return { registry, binder, engine, deliver: handler, reasonsSeen };
}

/** The scenario's first beat, as the frame the daemon would carry it in. */
function frameOfFirstBeat(): ScenarioSessionStreamFrame {
  const firstBeat = CONCURRENT_STREAMING_SCENARIO.beats[0];
  const [frame] = composeScenarioSessionFrames(firstBeat === undefined ? [] : [firstBeat.event]);
  if (frame === undefined) {
    throw new Error("the concurrent-streaming scenario plays no beats");
  }
  return frame;
}

// Tripwires throw in development so a breach is impossible to ignore. Under test
// they are RECORDED instead, because nothing here expects one to fire.
beforeEach(() => {
  windowTripwires.setThrowOnReport(false);
  windowTripwires.reset();
});

describe("SessionEventSubscriber — the drop mark", () => {
  it("marks the session short and asks for its re-read on the caught-up frame", async () => {
    // The frame with no changes: a session that went quiet right after a drop. With
    // nothing to apply, the store has no gap of its own to find, so the mark is the
    // only notice the rows are missing.
    const { registry, binder, engine, deliver, reasonsSeen } = await createBoundHarness();

    deliver({ changes: [], dropped: true, cursor: "cursor-after-the-drop" });

    expect(registry.peek(SESSION_ID)?.snapshot().degradedCause).toBe("sequence-gap");
    engine.advance(0);
    await settleMicrotasks();
    expect(reasonsSeen).toEqual(["gap-repull"]);
    expect(binder.unreadableDeliveryCount).toBe(0);

    binder.dispose();
  });

  it("repairs on the mark riding the first frame after the gap, and still queues its events", async () => {
    const { registry, binder, engine, deliver, reasonsSeen } = await createBoundHarness();

    deliver({ ...frameOfFirstBeat(), dropped: true });

    expect(binder.appliedEventCountFor(SESSION_ID)).toBe(1);
    expect(registry.peek(SESSION_ID)?.snapshot().degradedCause).toBe("sequence-gap");
    engine.advance(0);
    await settleMicrotasks();
    expect(reasonsSeen).toEqual(["gap-repull"]);

    binder.dispose();
  });

  it("negative control: a frame without the mark asks for no repair", async () => {
    // Without this, a subscriber that re-read on every frame would pass both cases
    // above, and would cost the daemon one read per frame for the life of the window.
    const { registry, binder, engine, deliver, reasonsSeen } = await createBoundHarness();

    deliver(frameOfFirstBeat());

    expect(binder.appliedEventCountFor(SESSION_ID)).toBe(1);
    expect(registry.peek(SESSION_ID)?.snapshot().degradedCause).toBeUndefined();
    engine.advance(0);
    await settleMicrotasks();
    expect(reasonsSeen).toEqual([]);

    binder.dispose();
  });
});
