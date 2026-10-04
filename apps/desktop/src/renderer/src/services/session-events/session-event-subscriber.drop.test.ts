// A frame carrying the daemon's drop mark, and the repair it asks for. When the daemon drops
// changes for a connection, a caught-up connection gets one frame with no changes and the mark. No
// scenario plays it, so the case hands the subscriber the frame itself through the fixture
// bridge's subscribe arm.

import { beforeEach, describe, expect, it } from "vitest";

import { createFixtureBridge } from "../platform/platform-bridge.fixture.js";
import { withDaemonSubscribe } from "@test/helpers/fixture-bridge.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { CONCURRENT_STREAMING_SCENARIO } from "@fixtures/scenarios/concurrent-streaming.js";
import { windowTripwires } from "@renderer/lib/tripwires.js";
import type { RefreshReason } from "@renderer/lib/reads/refresh-scheduler.js";
import type { ScenarioEngine } from "../daemon/engine.fixture.js";
import { SessionStoreRegistry } from "@renderer/store/session/session-store-registry.js";
import { SessionEventSubscriber } from "./session-event-subscriber.js";
import { SESSION_ID } from "./session-event-subscriber.test-support.js";

/** A subscriber whose session stream the case feeds, and the reads its registry performed. */
interface DropHarness {
  readonly registry: SessionStoreRegistry;
  readonly subscriber: SessionEventSubscriber;
  readonly engine: ScenarioEngine;
  /** Hands the bound session's subscription one delivered frame. */
  readonly deliver: (frame: unknown) => void;
  /** Every reason the registry's read was performed for, in order. */
  readonly reasonsSeen: RefreshReason[];
}

/**
 * The subscriber over the fixture bridge, its session bound and its opening read done. Its
 * handler is kept so a case can hand it a frame no scenario plays, and the opening `subscribe`
 * read is spent first so the reasons a case sees are the ones its frame asked for.
 */
async function createBoundHarness(): Promise<DropHarness> {
  // The concurrent-streaming session with no beats, so every event the subscriber sees is one the
  // case handed it.
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
  const subscriber = new SessionEventSubscriber({ registry, bridge });
  subscriber.attach();
  registry.open(SESSION_ID);
  engine.advance(0);
  await crossMacrotaskBoundary();
  expect(reasonsSeen).toEqual(["subscribe"]);
  reasonsSeen.length = 0;
  const [handler] = handlers;
  if (handler === undefined) {
    throw new Error("the subscriber opened no stream for the session");
  }
  return { registry, subscriber, engine, deliver: handler, reasonsSeen };
}

// Tripwires throw in development; under test they are recorded, since nothing here expects one.
beforeEach(() => {
  windowTripwires.setThrowOnReport(false);
  windowTripwires.reset();
});

describe("SessionEventSubscriber — the drop mark", () => {
  it("marks the session short and asks for its re-read on the caught-up frame", async () => {
    // The frame with no changes: a session that went quiet right after a drop. With nothing to
    // apply the store has no gap of its own to find, so the mark is the only notice.
    const { registry, subscriber, engine, deliver, reasonsSeen } = await createBoundHarness();

    deliver({ changes: [], dropped: true, cursor: "cursor-after-the-drop" });

    expect(registry.peek(SESSION_ID)?.snapshot().degradedCause).toBe("sequence-gap");
    engine.advance(0);
    await crossMacrotaskBoundary();
    expect(reasonsSeen).toEqual(["gap-repull"]);
    expect(subscriber.unreadableDeliveryCount).toBe(0);

    subscriber.dispose();
  });
});
