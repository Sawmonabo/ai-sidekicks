// The reply chokepoint: a reply off the contract never reaches a caller, a request off the contract
// never reaches the wire, a rejection becomes a refusal and never an exception, and a read whose
// owner has gone reads nothing from its reply. Every case drives the real `callDaemon` over the real
// registry and the shipped fixture bridge, so a hand-rolled parser cannot pass with the shipped one
// deleted. The shared helpers are `tests/helpers/daemon-reply-refusal.ts` and `fixture-bridge.ts`.

import type { SessionId } from "@ai-sidekicks/contracts";
import { vi } from "vitest";

import { isRefusal } from "@renderer/lib/refusal.js";
import type { PlatformBridge } from "../platform/platform-bridge.js";
import { callDaemon, DAEMON_REPLY_REFUSAL_ORIGIN } from "./daemon-reply.js";
import { DAEMON_METHOD_BINDINGS } from "./daemon-reply-registry.js";
import { refusalOf } from "@test/helpers/daemon-reply-refusal.js";
import { bridgeAnswering, createFixture } from "@test/helpers/fixture-bridge.js";

/** A device id the response schema accepts. */
const DEVICE_ID = "device-workstation";

/** A device state the response schema accepts. */
const ONLINE = "online";

/** A value the response schema rejects, shaped like content a refusal detail must never carry. */
const OFF_CONTRACT = "the person said something private";

/** One served presence reply, in the shape the registered schema admits. */
function servedPresenceReply(state: string): unknown {
  return {
    devices: [
      {
        deviceId: DEVICE_ID,
        deviceType: "desktop",
        appVisible: true,
        state,
      },
    ],
  };
}

describe("callDaemon — a served reply is a parsed reply", () => {
  it("serves the registered shape the daemon answered with", async () => {
    const { bridge, calls } = bridgeAnswering(async () => servedPresenceReply(ONLINE));

    const reply = await callDaemon(bridge, "presence.read", {});

    expect(calls).toStrictEqual([{ method: "presence.read", params: {} }]);
    expect(reply.status).toBe("served");
    if (reply.status === "served") {
      // Read through the bound response type, so a row pointing at the wrong schema also
      // fails at compile time.
      expect(reply.value.devices[0]?.deviceId).toBe(DEVICE_ID);
    }
  });
});

describe("callDaemon — a reply the contract does not admit is a refusal", () => {
  it("refuses an entirely wrong reply under the console's own code and origin", async () => {
    const { bridge } = bridgeAnswering(async () => ({ rows: [] }));

    const refusal = refusalOf(await callDaemon(bridge, "presence.read", {}));

    expect(refusal.code).toBe("reply-unreadable");
    expect(refusal.origin).toBe(DAEMON_REPLY_REFUSAL_ORIGIN);
    expect(refusal.detail).toContain("presence.read");
    expect(isRefusal(refusal)).toBe(true);
  });

  it("names the failing member path and never the refused value", async () => {
    // `callDaemon` composes its own sentence because the validator's interpolates the
    // rejected member, which can be a user's words, a path or a credential.
    const { bridge } = bridgeAnswering(async () => servedPresenceReply(OFF_CONTRACT));

    const refusal = refusalOf(await callDaemon(bridge, "presence.read", {}));

    expect(refusal.detail).toContain("devices.0.state");
    expect(refusal.detail).not.toContain(OFF_CONTRACT);
  });
});

describe("callDaemon — a request the contract does not admit is never sent", () => {
  it("refuses before the call, and the daemon sees nothing", async () => {
    const { bridge, calls } = bridgeAnswering(async () => servedPresenceReply(ONLINE));

    // The branded id is a compile-time marker over a string, so a caller can hand this seam a
    // value the wire would refuse; the parse stops it becoming a failing round trip.
    const refusal = refusalOf(
      await callDaemon(bridge, "session.read", {
        sessionId: "not-a-session-id" as SessionId,
      }),
    );

    expect(refusal.code).toBe("request-unsendable");
    expect(refusal.origin).toBe(DAEMON_REPLY_REFUSAL_ORIGIN);
    expect(refusal.detail).toContain("session.read");
    expect(calls).toStrictEqual([]);
  });
});

describe("callDaemon — a rejection becomes a refusal and never an exception", () => {
  it("keeps the daemon's own dotted code off a JSON-RPC rejection", async () => {
    // `JsonRpcRemoteError` carries the JSON-RPC numeric as `code` and the dotted code at
    // `data.type`, so a caller guarding on `{ code: string }` would render every daemon
    // refusal as one generic console code.
    const remote = Object.assign(new Error("no such session on this node"), {
      code: -32603,
      data: { type: "session.not_found" },
    });
    const { bridge } = bridgeAnswering(async () => {
      throw remote;
    });

    const refusal = refusalOf(await callDaemon(bridge, "presence.read", {}));

    expect(refusal.code).toBe("session.not_found");
    expect(refusal.detail).toBe("no such session on this node");
    // A `{ code: string }` guard would land on the generic console code.
    expect(refusal.code).not.toBe("call-rejected");
  });

  it("names a rejection that carries nothing machine-readable", async () => {
    const { bridge } = bridgeAnswering(async () => {
      throw new Error("the socket went away");
    });

    const refusal = refusalOf(await callDaemon(bridge, "presence.read", {}));

    expect(refusal.code).toBe("call-rejected");
    expect(refusal.detail).toContain("presence.read");
  });

  it("returns a refusal for a bridge that throws in the caller's own frame", async () => {
    // A synchronous throw from the bridge must not escape the promise and every `.catch`.
    // Overridden here rather than through `withDaemonCall`, whose arm is `async` and so
    // already turns a throw into a rejection, the one thing this case must not assert.
    const fixture = createFixture().bridge;
    const bridge: PlatformBridge = {
      ...fixture,
      daemon: {
        ...fixture.daemon,
        call: (() => {
          throw new Error("the preload did not install a handler");
        }) as PlatformBridge["daemon"]["call"],
      },
    };

    const refusal = refusalOf(await callDaemon(bridge, "presence.read", {}));

    expect(refusal.code).toBe("call-rejected");
  });
});

/** The code `callDaemon` raises for a read whose owner has gone. */
const READ_ABANDONED = "read-abandoned";

/** A reply the presence schema admits. */
function emptyPresenceReply(): unknown {
  return { devices: [] };
}

/** A reply the presence schema refuses, so a parse that ran shows as `reply-unreadable`. */
function refusedPresenceReply(): unknown {
  return { devices: "not a list" };
}

/**
 * A promise that never settles, and the release that answers it with `reply`. The body is a
 * parameter: a case whose claim is that nothing was parsed needs a body the parse would reject,
 * or a `callDaemon` that parsed and agreed would pass.
 */
function heldReply(reply: unknown): {
  readonly promise: Promise<unknown>;
  readonly release: () => void;
} {
  let release: () => void = () => undefined;
  const promise = new Promise<unknown>((resolve) => {
    release = () => resolve(reply);
  });
  return { promise, release };
}

/** The registered reply schema `callDaemon` resolves, so the spy watches the real parser. */
const PRESENCE_REPLY_SCHEMA = DAEMON_METHOD_BINDINGS["presence.read"].responseSchema;

/**
 * A reply that fulfills and queues the abandonment behind its own fulfillment.
 *
 * A hand-written thenable, because the interleaving is one microtask wide: the reply must win
 * `callDaemon`'s race and the abort land before its `await` resumes. Adopting a thenable calls
 * `then` with the adopting promise's resolver, so `settle` is that fulfillment and the
 * `queueMicrotask` is the first job after it; counting awaited turns would test the runtime.
 * The cast is needed because the bridge's call arm answers `Promise<unknown>`.
 */
function replyFulfillingAheadOfTheAbandonment(
  reply: unknown,
  line: AbortController,
): Promise<unknown> {
  return {
    then: (settle: (value: unknown) => void): void => {
      settle(reply);
      queueMicrotask(() => {
        line.abort();
      });
    },
  } as unknown as Promise<unknown>;
}

// A read line is a bare `AbortController` rather than `ReadScope`: `callDaemon`'s contract is an
// `AbortSignal`, and a scope would make a failure ambiguous.
describe("callDaemon — a read whose owner has gone", () => {
  it("reads nothing from a reply that arrives after the abandonment", async () => {
    const line = new AbortController();
    // A refusable reply: a `callDaemon` that parsed it would answer `reply-unreadable`, so the
    // code below shows the parse never ran, which a valid body could not.
    const held = heldReply(refusedPresenceReply());
    const underTest = bridgeAnswering(async () => await held.promise);

    const calling = callDaemon(underTest.bridge, "presence.read", {}, { signal: line.signal });
    line.abort();
    held.release();

    expect(refusalOf(await calling).code).toBe(READ_ABANDONED);
  });

  it("parses nothing when the abandonment lands between the settlement and the resume", async () => {
    const line = new AbortController();
    const replyParse = vi.spyOn(PRESENCE_REPLY_SCHEMA, "safeParse");
    // A reply the schema admits, on purpose: the answer cannot distinguish a `callDaemon` that
    // parsed it from one that did not, which is what the spy is for.
    const underTest = bridgeAnswering(() =>
      replyFulfillingAheadOfTheAbandonment(emptyPresenceReply(), line),
    );

    try {
      const reply = await callDaemon(
        underTest.bridge,
        "presence.read",
        {},
        { signal: line.signal },
      );

      expect(refusalOf(reply).code).toBe(READ_ABANDONED);
      expect(replyParse).not.toHaveBeenCalled();
      // The call was made and the line abandoned after the reply had settled the race.
      expect(underTest.calls.map((call) => call.method)).toStrictEqual(["presence.read"]);
      expect(line.signal.aborted).toBe(true);
    } finally {
      replyParse.mockRestore();
    }
  });
});
