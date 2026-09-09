// A window whose open threw, and the one returning edge that is worth a retry.
//
// Split out of `session-event-binder.test.ts` rather than left in it: those cases
// drive the fixture transport as it ships and ask what a DELIVERY does, and these
// drive a transport scripted to refuse and ask what a FAILED OPEN leaves behind.
// Different subject, different bridge, and the file that held both had grown past
// the bar `apps/desktop/CLAUDE.md` sets.
//
// The sharpest case here is the third: the binder used to be the only live producer
// of the transport signal AND its only consumer, so a window holding one session
// whose open threw could never emit the edge its own retry was waiting for. Nothing
// in that case opens a second session or reopens the first — the recovery arrives on
// a node-scoped tail belonging to no session at all.

import { beforeEach, describe, expect, it } from "vitest";

import {
  PROVIDER_ACCOUNT_SUBSCRIBE_STREAM,
  createFixtureBridge,
  subscribeNodeDaemon,
  type ConsoleBridge,
} from "../../bridge/index.js";
import { withDaemonSubscribe } from "../../bridge/fixture/call-plane/bridge.test-support.js";
import type { ScenarioEngine } from "../../bridge/scenario-runtime/scenario-engine.js";
import { FLAGSHIP_SCENARIO } from "../../bridge/scenarios/flagship.js";
import { APPLY_COALESCE_MS, type Unsubscribe } from "../../core/index.js";
import { consoleTripwires } from "../../core/tripwires.js";
import { SessionStoreRegistry } from "../../store/index.js";
import { SessionEventBinder } from "./session-event-binder.js";
import { PAST_EVERY_BEAT_MS, SESSION_ID } from "./session-event-binder.test-support.js";

/**
 * A transport that refuses to open a stream a stated number of times.
 *
 * The shipped Tier-1 preload is exactly this shape — `daemon.subscribe` throws
 * synchronously until a build with a real one is installed — so what the cases below
 * drive is the failure the console actually meets rather than a stand-in for it. A
 * class with a private field rather than a closed-over counter, per
 * `apps/desktop/AGENTS.md`, and refusals are COUNTED DOWN rather than switched off by
 * the case, so a retry that re-fails is expressible and the pass that has to survive
 * one is drivable.
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
  readonly binder: SessionEventBinder;
  readonly engine: ScenarioEngine;
  readonly bridge: ConsoleBridge;
  readonly outage: ScriptedStreamOutage;
  /** Every reason the registry's read was actually performed for, in order. */
  readonly reasonsSeen: string[];
}

/**
 * A registry, a fixture bridge whose `daemon.subscribe` refuses `refusalCount` times,
 * and a binder over both, with a REGISTERED read whose reasons are recorded.
 *
 * The registry is given the ENGINE's clock rather than one of its own, because there
 * is exactly one clock in fixture mode and a second would let the apply queue's
 * coalescing window and the scenario's beats drift apart. The read matters as much as
 * the subscription: the gap these cases cover is that a failed open skipped the
 * initial `requestRefresh` as well as the stream, so a session that came back had
 * neither. `refreshDebounceMs: 0` puts the read one frozen millisecond after the
 * request rather than a debounce interval away.
 */
function createOutageHarness(refusalCount: number): OutageHarness {
  const base = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
  const engine = base.scenarioEngine;
  if (engine === undefined) {
    throw new Error("the fixture bridge built no scenario engine, so there is nothing to drive");
  }
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
    binder: new SessionEventBinder({ registry, bridge }),
    engine,
    bridge,
    outage,
    reasonsSeen,
  };
}

// Tripwires throw in development so a breach is impossible to ignore. Under test
// they are RECORDED instead, because these cases assert that a breach was detected
// and described — a throw would only prove it was noticed.
beforeEach(() => {
  consoleTripwires.setThrowOnReport(false);
  consoleTripwires.reset();
});

describe("SessionEventBinder — the opens that failed, and what one returning edge is worth", () => {
  it("retains a session whose stream open threw, and says so on its store", () => {
    // The leak this closes: the early return left the session with no subscription
    // AND no initial read, and the registry's `opened` change for it had already been
    // delivered — so nothing was going to name that session again until somebody
    // closed and reopened it. Two readings have to be true here at once: the id is
    // retained for a retry, and the store carries a cause a surface can render.
    const { registry, binder, engine, bridge, reasonsSeen } = createOutageHarness(1);
    binder.attach();
    registry.open(SESSION_ID);

    engine.advance(1);

    expect(binder.boundSessionIds).toEqual([]);
    expect(binder.unboundSessionIds).toEqual([SESSION_ID]);
    expect(registry.peek(SESSION_ID)?.snapshot().degradedCause).toBe("subscription-closed");
    expect(bridge.transportReconnect.reachability).toBe("unreachable");
    // No stream and no read: the second half of the same gap, and the half a
    // subscription-only fix would leave open.
    expect(reasonsSeen).toEqual([]);
    expect(consoleTripwires.firingCount("apply-chokepoint-bypass")).toBe(1);

    binder.dispose();
  });

  it("retries the retained session on the transport's returning edge, read included", async () => {
    const { registry, binder, engine, bridge, reasonsSeen } = createOutageHarness(1);
    binder.attach();
    registry.open(SESSION_ID);
    expect(binder.unboundSessionIds).toEqual([SESSION_ID]);

    // The wire comes back, driven straight into the signal so this case states what a
    // returning edge is worth without also depending on who observed it. Who reports
    // one is `bridge/transport/observed-subscription.ts`, and the case below drives
    // that path rather than this one.
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
    // THE CYCLE THIS CLOSES, and it is the whole case. The binder used to be the only
    // live producer of the transport signal AND its only consumer, so a window holding
    // ONE session whose open threw could never emit the edge it needed: the retry
    // wanted a returning edge, and the returning edge wanted a successful bind. Nothing
    // below opens a second session and nothing reopens this one — the recovery is a
    // node-scoped tail belonging to no session at all, which is exactly the shape of
    // observation a window with nothing bindable still has.
    const { registry, binder, engine, bridge, reasonsSeen } = createOutageHarness(1);
    binder.attach();
    registry.open(SESSION_ID);
    expect(binder.unboundSessionIds).toEqual([SESSION_ID]);
    expect(bridge.transportReconnect.reachability).toBe("unreachable");

    const releaseNodeTail = subscribeNodeDaemon(
      bridge,
      PROVIDER_ACCOUNT_SUBSCRIBE_STREAM,
      () => undefined,
    );

    expect(binder.retriedBindCount).toBe(1);
    expect(binder.boundSessionIds).toEqual([SESSION_ID]);
    expect(binder.unboundSessionIds).toEqual([]);
    // The read the retry owes, so the recovered session is re-pulled rather than
    // merely re-subscribed — the half a subscription-only recovery would leave open.
    engine.advance(1);
    await Promise.resolve();
    expect(reasonsSeen).toEqual(["subscribe"]);

    releaseNodeTail();
    binder.dispose();
  });

  it("does not bind a second time when a later unrelated open observes the wire again", () => {
    // The other half of the case above: every open reports, so a window that opens
    // three more tails after recovering must not re-attempt a session it already
    // holds. `#bindSession` is idempotent by id and the signal emits on a CHANGE, and
    // this asserts the pair rather than either alone — a binder that re-attempted on
    // every observation would hold two subscriptions for one session and deliver each
    // beat twice.
    const { registry, binder, engine, bridge } = createOutageHarness(1);
    binder.attach();
    registry.open(SESSION_ID);
    const releaseFirstTail = subscribeNodeDaemon(
      bridge,
      PROVIDER_ACCOUNT_SUBSCRIBE_STREAM,
      () => undefined,
    );
    expect(binder.retriedBindCount).toBe(1);

    const releaseSecondTail = subscribeNodeDaemon(
      bridge,
      PROVIDER_ACCOUNT_SUBSCRIBE_STREAM,
      () => undefined,
    );

    expect(binder.retriedBindCount).toBe(1);
    expect(binder.boundSessionIds).toEqual([SESSION_ID]);
    engine.advance(PAST_EVERY_BEAT_MS);
    expect(binder.appliedEventCountFor(SESSION_ID)).toBe(FLAGSHIP_SCENARIO.beats.length);

    releaseFirstTail();
    releaseSecondTail();
    binder.dispose();
  });

  it("negative control: with no returning edge the same session is never retried", () => {
    // Without this the case above would pass over a binder that re-attempted on any
    // pass at all — a poll, a render, the next advance — which is the timer the
    // design forbids wearing a retry's clothes.
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
    // Two refusals were scripted and exactly one was spent, so the claim is made
    // against the TRANSPORT rather than against the binder's own count: nothing asked
    // it a second time.
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
    // The re-entrancy this closes: a pass where one retry fails and a later one
    // succeeds drives the signal `unreachable` and then `reachable` INSIDE the walk,
    // which is a returning edge delivered back into the same method. One pass is what
    // a returning edge is worth, so the still-failing session waits for the next one
    // rather than being re-attempted inside this one.
    const secondSessionId = `${SESSION_ID}-second`;
    const { registry, binder, bridge } = createOutageHarness(3);
    binder.attach();
    registry.open(SESSION_ID);
    registry.open(secondSessionId);
    expect(binder.unboundSessionIds).toEqual([SESSION_ID, secondSessionId]);

    bridge.transportReconnect.observe("reachable");

    // Two retries for two retained sessions, and not three: the first spends the last
    // scripted refusal, the second opens, and the edge that second open emits does
    // not start the walk again.
    expect(binder.retriedBindCount).toBe(2);
    expect(binder.boundSessionIds).toEqual([secondSessionId]);
    expect(binder.unboundSessionIds).toEqual([SESSION_ID]);

    binder.dispose();
  });
});
