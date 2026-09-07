// What the live bridge actually says to the preload.
//
// `bridge-shape.test.ts` beside this file checks that the two bridges have the same
// SHAPE. That leaves the other half untested: whether the live bridge, when a
// surface asks it for something, names the wire the corpus registered. A method
// string is the entire coupling between this renderer and a control-plane router,
// and a misspelling of one produces no type error, no runtime error, and no visible
// symptom — the read simply never resolves against anything, which reads exactly
// like a session with no runtime nodes in it.
//
// The preload is the stand-in here, and it has to be: `window.sidekicks` is
// installed by a process this test does not run. Everything above it is real — the
// real `createLiveBridge`, the real seam, the real registered name constants — and
// the stand-in is built from the contracts package's own `createTier1Bridge`, so it
// is the shape the preload actually installs rather than a hand-drawn one.
//
// EVERY CLEAN RESULT HERE HAS A CONTROL THAT FAILS. The forwarding cases run against
// a preload that answers ONLY the registered name, so a seam sending anything else
// refuses instead of resolving — and the case below it proves that gate bites by
// pointing the same preload at a plausible misspelling and watching the read refuse.

import { describe, expect, it } from "vitest";

import {
  createTier1Bridge,
  type SidekicksBridge,
  type Unsubscribe,
  type SessionId,
} from "@ai-sidekicks/contracts";

import { createLiveBridge } from "./live-bridge.js";
import {
  RUNTIME_NODE_PRESENCE_EVENT_NAMES,
  RUNTIME_NODE_ROSTER_PROCEDURE,
} from "./runtime-nodes/runtime-node-roster.js";

/** The session every case here reads. Shape-valid; nothing parses it. */
const SESSION_ID = "019b7904-8ce0-75e5-8510-ada11a5a33a5" as SessionId;

/** What a served roster resolves to, asserted verbatim so a stub cannot pass. */
const ROSTER_REPLY = { nodes: [], controlHolder: null };

/** A misspelling that is one underscore away from the registered name. */
const EVENT_STYLE_MISSPELLING = "runtime_node.roster";

interface PreloadStandIn {
  readonly bridge: SidekicksBridge;
  readonly procedures: string[];
  readonly events: string[];
  readonly releases: string[];
}

/**
 * A preload that answers one procedure name and subscribes to any event name.
 *
 * `servedProcedure` is a PARAMETER rather than the registered constant, which is
 * what makes the negative control possible: point it at a misspelling and the seam,
 * still sending the registered name, gets the refusal a real router would give it.
 *
 * The two casts are the Plan-007/Plan-008 brands. `CpProcedure` and `DaemonEvent`
 * are `never`-shaped, so no literal is assignable to them and no stand-in can be
 * written without one; the seam under test carries the same two casts and for the
 * same reason.
 */
function preloadStandIn(
  // `| undefined` on each member rather than a bare `?`: this package runs with
  // `exactOptionalPropertyTypes`, and the caller below reads an element out of a
  // readonly tuple, which is `T | undefined` under `noUncheckedIndexedAccess`.
  options: {
    readonly servedProcedure?: string | undefined;
    readonly refuseEvent?: string | undefined;
  } = {},
): PreloadStandIn {
  const servedProcedure = options.servedProcedure ?? RUNTIME_NODE_ROSTER_PROCEDURE;
  const procedures: string[] = [];
  const events: string[] = [];
  const releases: string[] = [];
  const call = async (procedure: string): Promise<unknown> => {
    procedures.push(procedure);
    if (procedure !== servedProcedure) {
      // The shape a typed wire refusal arrives in: a `{code, message}` envelope,
      // which is what a router answers for a procedure it does not mount.
      throw { code: "trpc.not_found", message: `no procedure named "${procedure}"` };
    }
    return ROSTER_REPLY;
  };
  const subscribe = (eventName: string): Unsubscribe => {
    if (eventName === options.refuseEvent) {
      throw new Error(`this daemon serves no "${eventName}" stream`);
    }
    events.push(eventName);
    return () => {
      releases.push(eventName);
    };
  };
  const base = createTier1Bridge();
  const bridge = {
    ...base,
    daemon: { ...base.daemon, subscribe },
    controlPlane: { ...base.controlPlane, call },
  } as unknown as SidekicksBridge;
  return { bridge, procedures, events, releases };
}

describe("the live bridge's roster read", () => {
  it("forwards the registered procedure name and the request verbatim", async () => {
    const preload = preloadStandIn();
    const outcome = await createLiveBridge(preload.bridge).runtimeNodeRosterRead({
      sessionId: SESSION_ID,
    });

    expect(preload.procedures).toStrictEqual([RUNTIME_NODE_ROSTER_PROCEDURE]);
    expect(outcome).toStrictEqual({ status: "served", value: ROSTER_REPLY });
  });

  it("refuses when the router mounts a different name, carrying the wire's code", async () => {
    // The negative control. This preload serves only the misspelling, so the case
    // above passes ONLY because the seam sends the registered string — and the
    // refusal here renders the router's own code rather than a console paraphrase,
    // which is what rule 9 requires of a refused read.
    const preload = preloadStandIn({ servedProcedure: EVENT_STYLE_MISSPELLING });
    const outcome = await createLiveBridge(preload.bridge).runtimeNodeRosterRead({
      sessionId: SESSION_ID,
    });

    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" ? outcome.code : "").toBe("trpc.not_found");
  });

  it("answers rather than rejecting when the preload throws synchronously", async () => {
    // The Tier-1 stub throws from the call itself rather than returning a rejected
    // promise, so a seam that did not funnel both into one arm would throw out of
    // the caller's effect. The thrower named no code — it is a class, not a wire
    // envelope — so the refusal carries the seam's own registered one rather than a
    // constructor name no contract registers and no search finds.
    const outcome = await createLiveBridge(createTier1Bridge()).runtimeNodeRosterRead({
      sessionId: SESSION_ID,
    });

    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" ? outcome.code : "").toBe("roster-read-failed");
  });
});

describe("the live bridge's presence subscription", () => {
  it("subscribes to exactly the registered event names", () => {
    const preload = preloadStandIn();
    const subscription = createLiveBridge(preload.bridge).runtimeNodePresenceSubscribe(
      SESSION_ID,
      () => undefined,
    );

    expect(subscription.status).toBe("subscribed");
    expect(preload.events).toStrictEqual([...RUNTIME_NODE_PRESENCE_EVENT_NAMES]);
  });

  it("releases every one of them on unsubscribe", () => {
    const preload = preloadStandIn();
    const subscription = createLiveBridge(preload.bridge).runtimeNodePresenceSubscribe(
      SESSION_ID,
      () => undefined,
    );
    if (subscription.status === "subscribed") {
      subscription.unsubscribe();
    }

    expect(preload.releases).toStrictEqual([...RUNTIME_NODE_PRESENCE_EVENT_NAMES]);
  });

  it("refuses as a whole when one registered name cannot be subscribed", () => {
    // All-or-nothing. A partial subscription delivers some transitions and drops
    // others, which reads as a roster that updates sometimes — and the handles
    // already taken are released rather than leaked.
    const refusedEvent = RUNTIME_NODE_PRESENCE_EVENT_NAMES[1];
    expect(refusedEvent).toBeDefined();
    const preload = preloadStandIn({ refuseEvent: refusedEvent });
    const subscription = createLiveBridge(preload.bridge).runtimeNodePresenceSubscribe(
      SESSION_ID,
      () => undefined,
    );

    expect(subscription.status).toBe("refused");
    expect(preload.releases).toStrictEqual(preload.events);
    expect(preload.events.length).toBeGreaterThan(0);
  });

  it("answers rather than throwing when the preload's subscribe throws", () => {
    // The crash this seam exists to prevent: the Tier-1 `daemon.subscribe` throws
    // synchronously, and a surface calling this inside a mount effect would take
    // that throw with no `catch` between it and React.
    const subscription = createLiveBridge(createTier1Bridge()).runtimeNodePresenceSubscribe(
      SESSION_ID,
      () => undefined,
    );

    expect(subscription.status).toBe("refused");
    expect(subscription.status === "refused" ? subscription.code : "").toBe(
      "presence-subscribe-failed",
    );
  });
});

describe("the presence subscription's session filter", () => {
  /** Deliver one payload to every handler the seam installed, and count the calls. */
  function signalsFor(payload: unknown): number {
    const handlers: ((payload: unknown) => void)[] = [];
    const base = createTier1Bridge();
    const bridge = {
      ...base,
      daemon: {
        ...base.daemon,
        subscribe: (_eventName: string, handler: (payload: unknown) => void): Unsubscribe => {
          handlers.push(handler);
          return () => undefined;
        },
      },
    } as unknown as SidekicksBridge;
    let signals = 0;
    createLiveBridge(bridge).runtimeNodePresenceSubscribe(SESSION_ID, () => {
      signals += 1;
    });
    // One handler per registered name; a delivery reaches the one that asked.
    const [firstHandler] = handlers;
    firstHandler?.(payload);
    return signals;
  }

  it("passes a delivery that names this session", () => {
    expect(signalsFor({ sessionId: SESSION_ID, nodeId: "node-a", newState: "online" })).toBe(1);
  });

  it("passes a delivery that names no session at all", () => {
    // Fails OPEN, deliberately: the member is optional on the registered payload,
    // and dropping a signal because it could not be read would leave the roster
    // silently stale, while passing one costs a coalesced re-read.
    expect(signalsFor({ nodeId: "node-a", newState: "online" })).toBe(1);
    expect(signalsFor("not an object at all")).toBe(1);
  });

  it("drops a delivery that names a different session", () => {
    // The negative control for both cases above: with no filter at all they would
    // pass for the wrong reason.
    expect(
      signalsFor({ sessionId: "019b7904-8ce0-75e5-8510-000000000000", nodeId: "node-a" }),
    ).toBe(0);
  });
});
