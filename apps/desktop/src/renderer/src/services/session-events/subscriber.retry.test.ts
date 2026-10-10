// A window whose open threw, and the returning edge that recovers it. These cases drive a
// transport scripted to refuse, while `subscriber.test.ts` asks what a delivery does.
// The second is the sharper: the subscriber must not be both the only producer and the only
// consumer of the transport signal, or a window with one failed session could never emit the edge
// its retry waits for. There the recovery arrives on a machine-scoped tail belonging to no session.

import { beforeEach, describe, expect, it } from "vitest";

import { PRESENCE_EVENT_STREAM } from "#shared/daemon/streams.js";
import { openObservedSubscription } from "../transport/observed-subscription.js";
import { createFixtureBridge } from "../platform/bridge.fixture.js";
import { type PlatformBridge } from "../platform/bridge.js";
import { withDaemonSubscribe } from "#test/helpers/fixture/bridge.js";
import { REOPEN_WAITS_MS } from "../transport/reopen-backoff.js";
import type { ScenarioEngine } from "../daemon/engine.fixture.js";
import { CONCURRENT_STREAMING_SCENARIO } from "#fixtures/scenarios/concurrent-streaming.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import { windowTripwires } from "#renderer/lib/tripwires/registry.js";
import { SessionStoreRegistry } from "#renderer/store/session/registry.js";
import { openingPageLimit, offScreenRowLimit } from "#test/helpers/session/store/fixtures.js";
import { SessionEventSubscriber } from "./subscriber.js";
import { PAST_EVERY_BEAT_MS, SESSION_ID, landReads } from "./subscriber.test-support.js";

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
 * much as the subscription: the stream opens only once a read has landed, and a failed first open
 * leaves a mark only a later read clears. `refreshDebounceMs: 0` puts the read on the next advance.
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
      return Promise.resolve({ entities: [] });
    },
    clock: engine.clock,
    openingPageLimit,
    offScreenRowLimit,
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
    await landReads(engine);
    expect(subscriber.unboundSessionIds).toEqual([SESSION_ID]);

    // The wire comes back, driven straight into the signal so this case states what a returning
    // edge is worth without depending on who observed it; the case below drives that path.
    bridge.transportReconnect.observe("reachable");

    expect(subscriber.retriedBindCount).toBe(1);
    expect(subscriber.boundSessionIds).toEqual([SESSION_ID]);
    expect(subscriber.unboundSessionIds).toEqual([]);

    // The first read placed the window; the retry owes the one that clears the failed open's mark.
    await landReads(engine);
    expect(reasonsSeen).toEqual(["subscribe", "subscribe"]);

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
    await landReads(engine);
    expect(subscriber.unboundSessionIds).toEqual([SESSION_ID]);
    expect(bridge.transportReconnect.reachability).toBe("unreachable");

    const releaseMachineTail = openObservedSubscription(bridge.transportReconnect, () =>
      bridge.daemon.subscribe(PRESENCE_EVENT_STREAM, {}, () => undefined),
    );

    expect(subscriber.retriedBindCount).toBe(1);
    expect(subscriber.boundSessionIds).toEqual([SESSION_ID]);
    expect(subscriber.unboundSessionIds).toEqual([]);
    // The retry owes a read, so the recovered session is re-pulled, not merely re-subscribed.
    await landReads(engine);
    expect(reasonsSeen).toEqual(["subscribe", "subscribe"]);

    releaseMachineTail();
    subscriber.dispose();
  });

  it("asks again for a first read that failed: after a wait with the wire up, on the edge without", async () => {
    // A read the daemon refuses with the wire still there brings no returning edge, so without the
    // wait nothing would read the session again and its stream would never open.
    const { bridge, scenarioEngine: engine } = createFixtureBridge({
      scenario: CONCURRENT_STREAMING_SCENARIO,
    });
    let readCount = 0;
    let failingReads = 1;
    const registry = new SessionStoreRegistry({
      read: () => {
        readCount += 1;
        if (failingReads > 0) {
          failingReads -= 1;
          return Promise.reject(new Error("the daemon refused the read"));
        }
        return Promise.resolve({ entities: [] });
      },
      clock: engine.clock,
      openingPageLimit,
      offScreenRowLimit,
      refreshDebounceMs: 0,
    });
    const subscriber = new SessionEventSubscriber({ registry, bridge, clock: engine.clock });
    subscriber.attach();
    registry.open(SESSION_ID);
    await landReads(engine);
    expect(readCount).toBe(1);
    expect(subscriber.boundSessionIds).toEqual([]);

    // The first wait after a failure is the one past none.
    engine.advance(REOPEN_WAITS_MS[1]!);
    await landReads(engine);
    expect(readCount).toBe(2);
    expect(subscriber.boundSessionIds).toEqual([SESSION_ID]);
    expect(subscriber.unboundSessionIds).toEqual([]);

    // With the wire away the returning edge asks instead, so no wait polls a link that is down.
    registry.close(SESSION_ID);
    failingReads = 1;
    bridge.transportReconnect.observe("unreachable");
    registry.open(SESSION_ID);
    await landReads(engine);
    expect(readCount).toBe(3);
    engine.advance(REOPEN_WAITS_MS.at(-1)! * 2);
    await landReads(engine);
    expect(readCount).toBe(3);
    bridge.transportReconnect.observe("reachable");
    await landReads(engine);
    expect(readCount).toBe(4);
    expect(subscriber.boundSessionIds).toEqual([SESSION_ID]);

    subscriber.dispose();
  });
});
