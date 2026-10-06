// The reply chokepoint: a reply off the contract never reaches a caller, a request off the contract
// never reaches the wire, a rejection becomes a refusal and never an exception, and a read whose
// owner has gone reads nothing from its reply. Every case drives the real `callDaemon` over the
// real registry and the shipped fixture bridge, so a hand-rolled parser cannot pass with the
// shipped one deleted. The helpers are `daemon-reply.test-support.ts` beside this file and the
// shared `tests/helpers/fixture/bridge.ts`.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { vi } from "vitest";

import { windowDiagnosticCapture } from "#renderer/lib/diagnostic-capture/diagnostic-capture.js";
import { isRefusal } from "#renderer/lib/refusal/refusal.js";
import type { PlatformBridge } from "../platform/platform-bridge.js";
import { callDaemon, DAEMON_REPLY_REFUSAL_ORIGIN } from "./daemon-reply.js";
import { DAEMON_METHOD_BINDINGS } from "#shared/daemon/method-bindings.js";
import { refusalOf } from "./daemon-reply.test-support.js";
import { bridgeAnswering, createFixture } from "#test/helpers/fixture/bridge.js";

/** A device id the response schema accepts. */
const DEVICE_ID = "device-workstation";

/** An `appVisible` the response schema accepts. */
const IN_FRONT = true;

/** A value the response schema rejects, shaped like content a refusal detail must never carry. */
const OFF_CONTRACT = "the person said something private";

/** One served presence reply, in the shape the registered schema admits. */
function servedPresenceReply(appVisible: unknown): unknown {
  return {
    devices: [
      {
        deviceId: DEVICE_ID,
        deviceType: "desktop",
        appVisible,
      },
    ],
  };
}

/**
 * What the window's diagnostic capture received while `act` ran, as JSONL text. Whatever was
 * pending before is drained first so the reading holds only this act's records.
 */
async function diagnosticsDuring(act: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const detach = windowDiagnosticCapture.installForwarder(() => undefined);
  detach();
  const detachCollector = windowDiagnosticCapture.installForwarder((jsonLines) => {
    lines.push(jsonLines);
  });
  try {
    await act();
    windowDiagnosticCapture.flush();
  } finally {
    detachCollector();
  }
  return lines.join("\n");
}

describe("callDaemon — a served reply is a parsed reply", () => {
  it("serves the registered shape the daemon answered with", async () => {
    const { bridge, calls } = bridgeAnswering(async () => servedPresenceReply(IN_FRONT));

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
  it("refuses an entirely wrong reply under the app's own code and origin", async () => {
    const { bridge } = bridgeAnswering(async () => ({ rows: [] }));

    let reply: Awaited<ReturnType<typeof callDaemon>> | undefined;
    const diagnostics = await diagnosticsDuring(async () => {
      reply = await callDaemon(bridge, "presence.read", {});
    });
    const refusal = refusalOf(reply ?? { status: "served", value: undefined });

    expect(refusal.code).toBe("reply-unreadable");
    expect(refusal.origin).toBe(DAEMON_REPLY_REFUSAL_ORIGIN);
    // The method is wire spelling: diagnostics carry it and the screen does not.
    expect(refusal.detail).not.toContain("presence.read");
    expect(diagnostics).toContain("presence.read");
    expect(isRefusal(refusal)).toBe(true);
  });

  it("records the failing member path and never the refused value", async () => {
    // The validator's own message interpolates the rejected member, which can be a user's
    // words, a path or a credential, so only the path is kept, and only for diagnostics.
    const { bridge } = bridgeAnswering(async () => servedPresenceReply(OFF_CONTRACT));

    let reply: Awaited<ReturnType<typeof callDaemon>> | undefined;
    const diagnostics = await diagnosticsDuring(async () => {
      reply = await callDaemon(bridge, "presence.read", {});
    });
    const refusal = refusalOf(reply ?? { status: "served", value: undefined });

    expect(diagnostics).toContain("devices.0.appVisible");
    expect(refusal.detail).not.toContain("devices.0.appVisible");
    expect(diagnostics).not.toContain(OFF_CONTRACT);
    expect(refusal.detail).not.toContain(OFF_CONTRACT);
  });
});

describe("callDaemon — a request the contract does not admit is never sent", () => {
  it("refuses before the call, and the daemon sees nothing", async () => {
    const { bridge, calls } = bridgeAnswering(async () => servedPresenceReply(IN_FRONT));

    // The branded id is a compile-time marker over a string, so a caller can hand this seam a
    // value the wire would refuse; the parse stops it becoming a failing round trip.
    let reply: Awaited<ReturnType<typeof callDaemon>> | undefined;
    const diagnostics = await diagnosticsDuring(async () => {
      reply = await callDaemon(bridge, "session.read", {
        sessionId: "not-a-session-id" as SessionId,
      });
    });
    const refusal = refusalOf(reply ?? { status: "served", value: undefined });

    expect(refusal.code).toBe("request-unsendable");
    expect(refusal.origin).toBe(DAEMON_REPLY_REFUSAL_ORIGIN);
    expect(refusal.detail).not.toContain("session.read");
    expect(diagnostics).toContain("session.read");
    expect(calls).toStrictEqual([]);
  });
});

describe("callDaemon — a rejection becomes a refusal and never an exception", () => {
  it("keeps the daemon's own dotted code off a JSON-RPC rejection", async () => {
    // `JsonRpcRemoteError` carries the JSON-RPC numeric as `code` and the dotted code at
    // `data.type`, so a caller guarding on `{ code: string }` would render every daemon
    // refusal as one generic app code.
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
    // A `{ code: string }` guard would land on the generic app code.
    expect(refusal.code).not.toBe("call-rejected");
  });

  it("records a rejection that carries nothing machine-readable", async () => {
    const { bridge } = bridgeAnswering(async () => {
      throw new Error("the socket went away");
    });

    let reply: Awaited<ReturnType<typeof callDaemon>> | undefined;
    const diagnostics = await diagnosticsDuring(async () => {
      reply = await callDaemon(bridge, "presence.read", {});
    });
    const refusal = refusalOf(reply ?? { status: "served", value: undefined });

    expect(refusal.code).toBe("call-rejected");
    expect(refusal.detail).not.toContain("presence.read");
    expect(diagnostics).toContain("presence.read");
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

  it("parses nothing when abandonment lands between the settlement and the resume", async () => {
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
