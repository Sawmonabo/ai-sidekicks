// The runtime-node seam's LIVE arms, which the fixture suite cannot reach.
//
// `runtime-node-roster.test.ts` drives the vocabulary module beside it and its
// scenario read. That left the two functions that touch a real transport — the
// control-plane read and the presence subscription — with no test at all, and those
// are the two that turn a rejection into something a person reads. So this file
// drives both against a scripted `SidekicksBridge`, and every case is about a way
// the seam could look right and be wrong:
//
//   • **A refusal renders the REFUSER's code.** A `JsonRpcRemoteError` carries the
//     JSON-RPC numeric at `code` and the project's dotted code at `data.type`, so a
//     seam reading the top-level member drops `ratelimit.concurrency_cap` on the
//     floor and renders a number's worth of nothing. The retry bound rides the same
//     envelope and is lost with it.
//   • **A rejection naming NO code takes one this console registers**, never the JS
//     class name of whatever was thrown. `NotImplementedAtTier1Error` is a
//     constructor, not a wire code: no contract registers it and no search finds it.
//   • **A live reply is PARSED before it is served.** The registered schema is
//     `.strict()`, and the fixture frames are already checked against it; a live
//     reply that was only cast would let a renamed member reach the surface as
//     `undefined` under a `served` status.
//   • **The subscription is all-or-nothing, and releases what it took.** A partial
//     subscription reads as a roster that updates sometimes.

import { describe, expect, it, vi } from "vitest";

import {
  createTier1Bridge,
  type SessionId,
  type SidekicksBridge,
  type Unsubscribe,
} from "@ai-sidekicks/contracts";

import {
  RUNTIME_NODE_PRESENCE_EVENT_NAMES,
  RUNTIME_NODE_ROSTER_REFUSAL_ORIGIN,
  RUNTIME_NODE_ROSTER_WIRE_REFUSAL_CODES,
  type RuntimeNodeRosterOutcome,
} from "./runtime-node-roster.js";
import {
  readRuntimeNodeRosterOverControlPlane,
  subscribeRuntimeNodePresence,
} from "./runtime-node-roster-transport.js";

/** The session every case reads. Shape-valid; the seam brands nothing itself. */
const SESSION_ID = "019b7904-8ce0-75e5-8510-ada11a5a33a5" as SessionId;

/** The registered dotted code a rate-limited subscription refuses with. */
const CONCURRENCY_CAP_CODE = "ratelimit.concurrency_cap";

/** Seconds the refusing side named. Read off `data.fields`, never invented. */
const RETRY_AFTER_SECONDS = 30;

/**
 * A control plane whose one procedure rejects with the value the case supplies.
 *
 * The rejection is a PARAMETER, because every claim here is about what the seam does
 * with a shape it did not choose. `createTier1Bridge` supplies the rest of the
 * surface, so the stand-in is the shape the preload really installs.
 */
function bridgeRejectingWith(rejection: unknown): SidekicksBridge {
  const base = createTier1Bridge();
  return {
    ...base,
    controlPlane: {
      ...base.controlPlane,
      call: async (): Promise<unknown> => {
        throw rejection;
      },
    },
  } as unknown as SidekicksBridge;
}

/** A control plane that resolves the supplied value, unparsed by the stand-in. */
function bridgeServing(reply: unknown): SidekicksBridge {
  const base = createTier1Bridge();
  return {
    ...base,
    controlPlane: { ...base.controlPlane, call: async (): Promise<unknown> => reply },
  } as unknown as SidekicksBridge;
}

/** The refusal, or a failure naming what the read answered instead. */
function refusalOf(outcome: RuntimeNodeRosterOutcome): {
  code: string;
  detail: string;
  origin: string;
  retryAfterSeconds: number | undefined;
} {
  expect(outcome.status, "the read was expected to refuse").toBe("refused");
  if (outcome.status !== "refused") {
    return { code: "", detail: "", origin: "", retryAfterSeconds: undefined };
  }
  return {
    code: outcome.code,
    detail: outcome.detail,
    origin: outcome.origin,
    retryAfterSeconds: outcome.retry?.afterSeconds,
  };
}

describe("the live roster read's refusals", () => {
  it("renders the wire's dotted code and its retry bound, not the JSON-RPC numeric", async () => {
    // The shape `JsonRpcRemoteError` arrives in: the numeric at `code`, the project
    // code at `data.type`, and the registered bounds under `data.fields`. A seam
    // that read the top-level member would render `-32000` and no hint at all.
    const outcome = await readRuntimeNodeRosterOverControlPlane(
      bridgeRejectingWith(
        Object.assign(new Error("too many concurrent subscriptions"), {
          code: -32000,
          data: { type: CONCURRENCY_CAP_CODE, fields: { retryAfter: RETRY_AFTER_SECONDS } },
        }),
      ),
      { sessionId: SESSION_ID },
    );

    const refusal = refusalOf(outcome);
    expect(refusal.code).toBe(CONCURRENCY_CAP_CODE);
    expect(refusal.retryAfterSeconds).toBe(RETRY_AFTER_SECONDS);
    expect(refusal.origin).toBe(RUNTIME_NODE_ROSTER_REFUSAL_ORIGIN);
  });

  it("renders a flat wire envelope's own code verbatim", async () => {
    const outcome = await readRuntimeNodeRosterOverControlPlane(
      bridgeRejectingWith({ code: "runtimenode.permission_denied", message: "not a member" }),
      { sessionId: SESSION_ID },
    );

    expect(refusalOf(outcome).code).toBe("runtimenode.permission_denied");
  });

  it("gives a code-less rejection this seam's own registered code", async () => {
    // The Tier-1 preload throws a class carrying no `code` at all, which is the
    // production-observable path until the IPC handler lands.
    const outcome = await readRuntimeNodeRosterOverControlPlane(createTier1Bridge(), {
      sessionId: SESSION_ID,
    });

    expect(refusalOf(outcome).code).toBe("roster-read-failed");
  });

  it("negative control: a rejection's constructor name never becomes the code", async () => {
    // The defect this file exists to pin. A class name reads like a code and is
    // registered nowhere, so a surface renders a string no search will ever find.
    class RosterUnavailableError extends Error {}
    const outcome = await readRuntimeNodeRosterOverControlPlane(
      bridgeRejectingWith(new RosterUnavailableError("the socket closed")),
      { sessionId: SESSION_ID },
    );

    const refusal = refusalOf(outcome);
    expect(refusal.code).not.toBe("RosterUnavailableError");
    expect(refusal.code).toBe("roster-read-failed");
    // And the SENTENCE is the seam's own too, on this arm alone: a rejection that
    // named no code named no reason either, so what a person reads says that rather
    // than repeating a transport's note to itself.
    expect(refusal.detail).not.toContain("the socket closed");
  });
});

describe("the live roster read's reply", () => {
  it("serves a reply the registered schema admits", async () => {
    const outcome = await readRuntimeNodeRosterOverControlPlane(bridgeServing({ nodes: [] }), {
      sessionId: SESSION_ID,
    });

    expect(outcome).toStrictEqual({ status: "served", value: { nodes: [] } });
  });

  it("refuses a reply the registered schema does not admit, rather than serving it", async () => {
    // A control plane one revision ahead renames `state`. Cast, the member reaches
    // the surface as `undefined` under a `served` status and the never-mask reading
    // silently stops distinguishing a degraded node. Parsed, it refuses.
    const outcome = await readRuntimeNodeRosterOverControlPlane(
      bridgeServing({ nodes: [{ nodeId: "n1", healthState: "degraded" }] }),
      { sessionId: SESSION_ID },
    );

    expect(refusalOf(outcome).code).toBe("roster-reply-unreadable");
  });

  it("negative control: a reply that is not even an object refuses too", async () => {
    // The parse has to be the gate rather than a shape guard over one member: a
    // reply of `null` has no `nodes` to read and a cast would hand it straight on.
    const outcome = await readRuntimeNodeRosterOverControlPlane(bridgeServing(null), {
      sessionId: SESSION_ID,
    });

    expect(refusalOf(outcome).code).toBe("roster-reply-unreadable");
  });
});

/** A daemon that subscribes to every name, or throws on the one the case names. */
function bridgeSubscribing(options: {
  readonly refuseEventName?: string | undefined;
  readonly rejection?: unknown;
}): {
  readonly bridge: SidekicksBridge;
  readonly taken: string[];
  readonly released: string[];
  readonly handlersByEventName: Map<string, (payload: unknown) => void>;
} {
  const taken: string[] = [];
  const released: string[] = [];
  const handlersByEventName = new Map<string, (payload: unknown) => void>();
  const base = createTier1Bridge();
  const bridge = {
    ...base,
    daemon: {
      ...base.daemon,
      subscribe: (eventName: string, handler: (payload: unknown) => void): Unsubscribe => {
        if (eventName === options.refuseEventName) {
          throw options.rejection ?? new Error(`no "${eventName}" stream`);
        }
        taken.push(eventName);
        handlersByEventName.set(eventName, handler);
        return () => {
          released.push(eventName);
        };
      },
    },
  } as unknown as SidekicksBridge;
  return { bridge, taken, released, handlersByEventName };
}

describe("the live presence subscription", () => {
  it("takes every registered state-transition name, in the set's own order", () => {
    const daemon = bridgeSubscribing({});
    const subscription = subscribeRuntimeNodePresence(daemon.bridge, SESSION_ID, () => undefined);

    expect(subscription.status).toBe("subscribed");
    expect(daemon.taken).toStrictEqual([...RUNTIME_NODE_PRESENCE_EVENT_NAMES]);
  });

  it("signals on a delivery for this session and drops one naming another", () => {
    const daemon = bridgeSubscribing({});
    const onPresenceChange = vi.fn();
    subscribeRuntimeNodePresence(daemon.bridge, SESSION_ID, onPresenceChange);
    const [firstEventName] = RUNTIME_NODE_PRESENCE_EVENT_NAMES;
    const handler = handlerFor(daemon.handlersByEventName, firstEventName);

    handler({ sessionId: SESSION_ID });
    handler({});
    expect(onPresenceChange).toHaveBeenCalledTimes(2);

    handler({ sessionId: "019b7904-8ce0-75e5-8510-000000000000" });
    expect(onPresenceChange).toHaveBeenCalledTimes(2);
  });

  it("releases the handles it already took when a later name throws", () => {
    // All-or-nothing. The third name refuses, so the two before it are released
    // rather than left open under a subscription the caller never receives.
    const refusedEventName = RUNTIME_NODE_PRESENCE_EVENT_NAMES[2];
    expect(refusedEventName).toBeDefined();
    const daemon = bridgeSubscribing({ refuseEventName: refusedEventName });
    const subscription = subscribeRuntimeNodePresence(daemon.bridge, SESSION_ID, () => undefined);

    expect(subscription.status).toBe("refused");
    expect(daemon.taken).toHaveLength(2);
    expect(daemon.released).toStrictEqual(daemon.taken);
  });

  it("carries the refusing wire's own dotted code and retry bound", () => {
    const refusedEventName = RUNTIME_NODE_PRESENCE_EVENT_NAMES[0];
    expect(refusedEventName).toBeDefined();
    const daemon = bridgeSubscribing({
      refuseEventName: refusedEventName,
      rejection: Object.assign(new Error("the cap is full"), {
        code: -32000,
        data: { type: CONCURRENCY_CAP_CODE, fields: { retryAfter: RETRY_AFTER_SECONDS } },
      }),
    });
    const subscription = subscribeRuntimeNodePresence(daemon.bridge, SESSION_ID, () => undefined);

    expect(subscription.status).toBe("refused");
    expect(subscription.status === "refused" ? subscription.code : "").toBe(CONCURRENCY_CAP_CODE);
    expect(subscription.status === "refused" ? subscription.retry?.afterSeconds : undefined).toBe(
      RETRY_AFTER_SECONDS,
    );
  });

  it("raises every wire code it declares, and declares every wire code it raises", () => {
    // The census, over the arm the fixture suite cannot reach. Each of the three is
    // raised by a case above, so a code declared and never reachable fails here.
    const raised = new Set<string>();
    const rejecting = bridgeSubscribing({
      refuseEventName: RUNTIME_NODE_PRESENCE_EVENT_NAMES[0],
    });
    const subscription = subscribeRuntimeNodePresence(
      rejecting.bridge,
      SESSION_ID,
      () => undefined,
    );
    raised.add(subscription.status === "refused" ? subscription.code : "");
    return (async (): Promise<void> => {
      raised.add(
        refusalOf(
          await readRuntimeNodeRosterOverControlPlane(createTier1Bridge(), {
            sessionId: SESSION_ID,
          }),
        ).code,
      );
      raised.add(
        refusalOf(
          await readRuntimeNodeRosterOverControlPlane(bridgeServing({ rows: [] }), {
            sessionId: SESSION_ID,
          }),
        ).code,
      );
      expect([...raised].sort()).toStrictEqual([...RUNTIME_NODE_ROSTER_WIRE_REFUSAL_CODES].sort());
    })();
  });

  it("negative control: a code-less throw takes the seam's code, never its class name", () => {
    class PresenceChannelClosedError extends Error {}
    const refusedEventName = RUNTIME_NODE_PRESENCE_EVENT_NAMES[0];
    expect(refusedEventName).toBeDefined();
    const daemon = bridgeSubscribing({
      refuseEventName: refusedEventName,
      rejection: new PresenceChannelClosedError("the channel closed"),
    });
    const subscription = subscribeRuntimeNodePresence(daemon.bridge, SESSION_ID, () => undefined);

    const code = subscription.status === "refused" ? subscription.code : "";
    expect(code).not.toBe("PresenceChannelClosedError");
    expect(code).toBe("presence-subscribe-failed");
  });
});

/** One installed handler, or a failure naming the name that has none. */
function handlerFor(
  handlersByEventName: Map<string, (payload: unknown) => void>,
  eventName: string | undefined,
): (payload: unknown) => void {
  const handler = eventName === undefined ? undefined : handlersByEventName.get(eventName);
  expect(handler, `no handler installed for ${eventName ?? "an unnamed event"}`).toBeDefined();
  return handler ?? ((): void => undefined);
}
