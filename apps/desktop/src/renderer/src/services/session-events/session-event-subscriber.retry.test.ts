// A window whose open threw, and the returning edge that recovers it. These cases drive a
// transport scripted to refuse, while `session-event-subscriber.test.ts` asks what a delivery does.
// The second is the sharper: the subscriber must not be both the only producer and the only
// consumer of the transport signal, or a window with one failed session could never emit the edge
// its retry waits for. There the recovery arrives on a machine-scoped tail belonging to no session.

import { beforeEach, describe, expect, it } from "vitest";

import { PRESENCE_EVENT_STREAM } from "#shared/daemon/daemon-streams.js";
import { openObservedSubscription } from "../transport/observed-subscription.js";
import { createFixtureBridge } from "../platform/platform-bridge.fixture.js";
import { type PlatformBridge } from "../platform/platform-bridge.js";
import { withDaemonSubscribe } from "#test/helpers/fixture/bridge.js";
import type { ScenarioEngine } from "../daemon/engine.fixture.js";
import { CONCURRENT_STREAMING_SCENARIO } from "#fixtures/scenarios/concurrent-streaming.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import { windowTripwires } from "#renderer/lib/tripwires/tripwires.js";
import { SessionStoreRegistry } from "#renderer/store/session/session-store-registry.js";
import { SessionEventSubscriber } from "./session-event-subscriber.js";
import { PAST_EVERY_BEAT_MS, SESSION_ID } from "./session-event-subscriber.test-support.js";

/**
 * A transport that refuses to open a stream a stated number of times, the failure the shipped stub
 * preload produces (`daemon.subscribe` throws synchronously).
 */
class ScriptedStreamOutage {
  #refusalsRemaining: number;

  public constructor(refusalCount: number) {
    this.#refusalsRemaining = refusalCount;
  }

  public openStream(passThrough: () => Unsubscribe): Unsubscribe {
    if (this.#refusalsRemaining > 0) {
      this.#refusalsRemaining -= 1;
      throw new Error("the daemon event stream is not reachable from this window");
    }
    return passThrough();
  }
}

/** A subscriber over a transport whose first opens throw, and the reads it asks for. */
interface OutageHarness {
  readonly registry: SessionStoreRegistry;
  readonly subscriber: SessionEventSubscriber;
  readonly engine: ScenarioEngine;
  readonly bridge: PlatformBridge;
  /** Every reason the registry's read was actually performed for, in order. */
  readonly reasonsSeen: string[];
}

/**
 * A registry, a fixture bridge whose `daemon.subscribe` refuses `refusalCount` times, and a
 * subscriber over both, with a registered read whose reasons are recorded. The registry takes the
 * engine's clock so the apply queue and the scenario's beats cannot drift. The read matters as
 * much as the subscription: a failed open skipped the initial `requestRefresh` too.
 * `refreshDebounceMs: 0` puts the read one frozen millisecond after the request.
 */
function createOutageHarness(refusalCount: number): OutageHarness {
  const { bridge: base, scenarioEngine: engine } = createFixtureBridge({
    scenario: CONCURRENT_STREAMING_SCENARIO,
  });
  const outage = new ScriptedStreamOutage(refusalCount);
  const bridge = withDaemonSubscribe(base, (passThrough) => outage.openStream(passThrough));
  const reasonsSeen: string[] = [];
  const registry = new SessionStoreRegistry({
    read: (_sessionId, reasons) => {
      reasonsSeen.push(...reasons);
      return Promise.resolve(undefined);
    },
    clock: engine.clock,
    refreshDebounceMs: 0,
  });
  return {
    registry,
    subscriber: new SessionEventSubscriber({ registry, bridge }),
    engine,
    bridge,
    reasonsSeen,
  };
}

// Tripwires throw in development; under test they are recorded.
beforeEach(() => {
  windowTripwires.setThrowOnReport(false);
  windowTripwires.reset();
});

describe("SessionEventSubscriber: failed opens, and what one returning edge is worth", () => {
  it("retries the retained session on the transport's returning edge, read included", async () => {
    const { registry, subscriber, engine, bridge, reasonsSeen } = createOutageHarness(1);
    subscriber.attach();
    registry.open(SESSION_ID);
    expect(subscriber.unboundSessionIds).toEqual([SESSION_ID]);

    // The wire comes back, driven straight into the signal so this case states what a returning
    // edge is worth without depending on who observed it; the case below drives that path.
    bridge.transportReconnect.observe("reachable");

    expect(subscriber.retriedBindCount).toBe(1);
    expect(subscriber.boundSessionIds).toEqual([SESSION_ID]);
    expect(subscriber.unboundSessionIds).toEqual([]);

    engine.advance(1);
    await Promise.resolve();
    expect(reasonsSeen).toEqual(["subscribe"]);

    engine.advance(PAST_EVERY_BEAT_MS);
    expect(subscriber.appliedEventCountFor(SESSION_ID)).toBeGreaterThan(0);

    subscriber.dispose();
  });

  it("re-binds the one retained session when an unrelated stream open sees the wire", async () => {
    // The cycle this closes: the retry wanted a returning edge and the edge wanted a successful
    // bind. Nothing here opens a second session or reopens this one; the recovery is a
    // node-scoped tail belonging to no session, which a window with nothing bindable still
    // observes.
    const { registry, subscriber, engine, bridge, reasonsSeen } = createOutageHarness(1);
    subscriber.attach();
    registry.open(SESSION_ID);
    expect(subscriber.unboundSessionIds).toEqual([SESSION_ID]);
    expect(bridge.transportReconnect.reachability).toBe("unreachable");

    const releaseMachineTail = openObservedSubscription(bridge.transportReconnect, () =>
      bridge.daemon.subscribe(PRESENCE_EVENT_STREAM, {}, () => undefined),
    );

    expect(subscriber.retriedBindCount).toBe(1);
    expect(subscriber.boundSessionIds).toEqual([SESSION_ID]);
    expect(subscriber.unboundSessionIds).toEqual([]);
    // The retry owes a read, so the recovered session is re-pulled, not merely re-subscribed.
    engine.advance(1);
    await Promise.resolve();
    expect(reasonsSeen).toEqual(["subscribe"]);

    releaseMachineTail();
    subscriber.dispose();
  });
});
