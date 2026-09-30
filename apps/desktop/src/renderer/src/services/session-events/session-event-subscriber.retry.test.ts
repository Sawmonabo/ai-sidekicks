// A window whose open threw, and the one returning edge worth a retry. These cases drive a
// transport scripted to refuse and ask what a failed open leaves behind, while
// `session-event-subscriber.test.ts` asks what a delivery does. The sharpest is the third: the
// subscriber must not be both the only producer and the only consumer of the transport signal, or a
// window with one failed session could never emit the edge its retry waits for. There the recovery
// arrives on a node-scoped tail belonging to no session.

import { beforeEach, describe, expect, it } from "vitest";

import {
  PROVIDER_ACCOUNT_SUBSCRIBE_STREAM,
  subscribeNodeDaemon,
} from "../daemon/daemon-streams.js";
import { createFixtureBridge } from "../platform/platform-bridge.fixture.js";
import { type PlatformBridge } from "../platform/platform-bridge.js";
import { withDaemonSubscribe } from "@test/helpers/fixture-bridge.js";
import type { ScenarioEngine } from "../daemon/engine.fixture.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../../../../fixtures/scenarios/concurrent-streaming.js";
import { APPLY_COALESCE_MS } from "@renderer/lib/reads/refresh-caps.js";
import { type Unsubscribe } from "@renderer/lib/emitter.js";
import { windowTripwires } from "@renderer/lib/tripwires.js";
import { SessionStoreRegistry } from "@renderer/store/session/session-store-registry.js";
import { SessionEventSubscriber } from "./session-event-subscriber.js";
import { PAST_EVERY_BEAT_MS, SESSION_ID } from "./session-event-subscriber.test-support.js";

/**
 * A transport that refuses to open a stream a stated number of times, the failure the shipped stub
 * preload produces (`daemon.subscribe` throws synchronously). Refusals are counted down rather than
 * switched off, so a retry that re-fails is expressible.
 */
class ScriptedStreamOutage {
  #refusalsRemaining: number;

  public constructor(refusalCount: number) {
    this.#refusalsRemaining = refusalCount;
  }

  public get refusalsRemaining(): number {
    return this.#refusalsRemaining;
  }

  public openStream(passThrough: () => Unsubscribe): Unsubscribe {
    if (this.#refusalsRemaining > 0) {
      this.#refusalsRemaining -= 1;
      throw new Error("the daemon event stream is not reachable from this window");
    }
    return passThrough();
  }
}

/** A binder over a transport whose first opens throw, and the reads it asks for. */
interface OutageHarness {
  readonly registry: SessionStoreRegistry;
  readonly binder: SessionEventSubscriber;
  readonly engine: ScenarioEngine;
  readonly bridge: PlatformBridge;
  readonly outage: ScriptedStreamOutage;
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
    binder: new SessionEventSubscriber({ registry, bridge }),
    engine,
    bridge,
    outage,
    reasonsSeen,
  };
}

// Tripwires throw in development; under test they are recorded, because these cases assert that a
// breach was detected and described.
beforeEach(() => {
  windowTripwires.setThrowOnReport(false);
  windowTripwires.reset();
});

describe("SessionEventSubscriber — the opens that failed, and what one returning edge is worth", () => {
  it("retains a session whose stream open threw, and says so on its store", () => {
    // The id is retained for a retry and the store carries a cause a view can render; otherwise the
    // session has no subscription and no read, and nothing would name it again until reopened.
    const { registry, binder, engine, bridge, reasonsSeen } = createOutageHarness(1);
    binder.attach();
    registry.open(SESSION_ID);

    engine.advance(1);

    expect(binder.boundSessionIds).toEqual([]);
    expect(binder.unboundSessionIds).toEqual([SESSION_ID]);
    expect(registry.peek(SESSION_ID)?.snapshot().degradedCause).toBe("subscription-closed");
    expect(bridge.transportReconnect.reachability).toBe("unreachable");
    // No stream and no read: the half a subscription-only fix would leave open.
    expect(reasonsSeen).toEqual([]);
    expect(windowTripwires.firingCount("apply-chokepoint-bypass")).toBe(1);

    binder.dispose();
  });

  it("retries the retained session on the transport's returning edge, read included", async () => {
    const { registry, binder, engine, bridge, reasonsSeen } = createOutageHarness(1);
    binder.attach();
    registry.open(SESSION_ID);
    expect(binder.unboundSessionIds).toEqual([SESSION_ID]);

    // The wire comes back, driven straight into the signal so this case states what a returning
    // edge is worth without depending on who observed it; the case below drives that path.
    bridge.transportReconnect.observe("reachable");

    expect(binder.retriedBindCount).toBe(1);
    expect(binder.boundSessionIds).toEqual([SESSION_ID]);
    expect(binder.unboundSessionIds).toEqual([]);

    engine.advance(1);
    await Promise.resolve();
    expect(reasonsSeen).toEqual(["subscribe"]);

    engine.advance(PAST_EVERY_BEAT_MS);
    expect(binder.appliedEventCountFor(SESSION_ID)).toBeGreaterThan(0);

    binder.dispose();
  });

  it("re-binds the only retained session when an unrelated stream open observes the wire", async () => {
    // The cycle this closes: the retry wanted a returning edge and the edge wanted a successful
    // bind. Nothing here opens a second session or reopens this one; the recovery is a node-scoped
    // tail belonging to no session, which a window with nothing bindable still observes.
    const { registry, binder, engine, bridge, reasonsSeen } = createOutageHarness(1);
    binder.attach();
    registry.open(SESSION_ID);
    expect(binder.unboundSessionIds).toEqual([SESSION_ID]);
    expect(bridge.transportReconnect.reachability).toBe("unreachable");

    const releaseNodeTail = subscribeNodeDaemon(
      bridge,
      PROVIDER_ACCOUNT_SUBSCRIBE_STREAM,
      {},
      () => undefined,
    );

    expect(binder.retriedBindCount).toBe(1);
    expect(binder.boundSessionIds).toEqual([SESSION_ID]);
    expect(binder.unboundSessionIds).toEqual([]);
    // The retry owes a read, so the recovered session is re-pulled, not merely re-subscribed.
    engine.advance(1);
    await Promise.resolve();
    expect(reasonsSeen).toEqual(["subscribe"]);

    releaseNodeTail();
    binder.dispose();
  });

  it("does not bind a second time when a later unrelated open observes the wire again", () => {
    // Every open reports, so a window opening three more tails after recovering must not re-attempt
    // a session it holds. `#bindSession` is idempotent by id and the signal emits on a change;
    // re-attempting on every observation would double each beat.
    const { registry, binder, engine, bridge } = createOutageHarness(1);
    binder.attach();
    registry.open(SESSION_ID);
    const releaseFirstTail = subscribeNodeDaemon(
      bridge,
      PROVIDER_ACCOUNT_SUBSCRIBE_STREAM,
      {},
      () => undefined,
    );
    expect(binder.retriedBindCount).toBe(1);

    const releaseSecondTail = subscribeNodeDaemon(
      bridge,
      PROVIDER_ACCOUNT_SUBSCRIBE_STREAM,
      {},
      () => undefined,
    );

    expect(binder.retriedBindCount).toBe(1);
    expect(binder.boundSessionIds).toEqual([SESSION_ID]);
    engine.advance(PAST_EVERY_BEAT_MS);
    expect(binder.appliedEventCountFor(SESSION_ID)).toBe(
      CONCURRENT_STREAMING_SCENARIO.beats.length,
    );

    releaseFirstTail();
    releaseSecondTail();
    binder.dispose();
  });

  it("negative control: with no returning edge the same session is never retried", () => {
    // Without this the case above would pass over a subscriber that re-attempted on any pass (a
    // poll, a render, the next advance), the timer the design forbids.
    const { registry, binder, engine, outage, reasonsSeen } = createOutageHarness(2);
    binder.attach();
    registry.open(SESSION_ID);

    engine.advance(PAST_EVERY_BEAT_MS);
    engine.advance(APPLY_COALESCE_MS + 1);

    expect(binder.retriedBindCount).toBe(0);
    expect(binder.boundSessionIds).toEqual([]);
    expect(binder.unboundSessionIds).toEqual([SESSION_ID]);
    expect(binder.appliedEventCountFor(SESSION_ID)).toBe(0);
    expect(reasonsSeen).toEqual([]);
    // Two refusals were scripted and one spent, so the claim is against the transport, not the
    // subscriber's own count: nothing asked it a second time.
    expect(outage.refusalsRemaining).toBe(1);

    binder.dispose();
  });

  it("does not retry a session that closed between the failed open and the return", () => {
    const { registry, binder, engine, bridge, outage } = createOutageHarness(1);
    binder.attach();
    registry.open(SESSION_ID);
    expect(binder.unboundSessionIds).toEqual([SESSION_ID]);

    registry.close(SESSION_ID);
    bridge.transportReconnect.observe("reachable");

    expect(binder.retriedBindCount).toBe(0);
    expect(binder.unboundSessionIds).toEqual([]);
    expect(binder.boundSessionIds).toEqual([]);
    // Nothing was opened on the wire for a session this window no longer holds.
    expect(engine.sinkCount).toBe(0);
    expect(outage.refusalsRemaining).toBe(0);

    binder.dispose();
  });

  it("makes one pass over the retained set even when the retry itself moves the signal", () => {
    // A pass where one retry fails and a later one succeeds drives the signal `unreachable` then
    // `reachable` inside the walk, a returning edge delivered back into the same method. The
    // still-failing session waits for the next edge.
    const secondSessionId = "019b79ee-0280-75e5-8510-ada11a5a22b5";
    const { registry, binder, bridge } = createOutageHarness(3);
    binder.attach();
    registry.open(SESSION_ID);
    registry.open(secondSessionId);
    expect(binder.unboundSessionIds).toEqual([SESSION_ID, secondSessionId]);

    bridge.transportReconnect.observe("reachable");

    // Two retries for two retained sessions, not three: the second open's edge does not restart
    // the walk.
    expect(binder.retriedBindCount).toBe(2);
    expect(binder.boundSessionIds).toEqual([secondSessionId]);
    expect(binder.unboundSessionIds).toEqual([SESSION_ID]);

    binder.dispose();
  });
});
