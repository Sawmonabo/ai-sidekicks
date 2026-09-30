// The reply chokepoint on the rejection arm: every way a call can fail becomes a refusal and none
// becomes an exception. The cases enumerate the shapes a rejection arrives in, since a shape
// missing from the list reaches the view as a crash. Every case drives the real `callDaemon` over
// the real registry and the shipped fixture bridge. The parse arm is `daemon-reply.test.ts`.

import { RefusalError, refuse, type Refusal } from "@renderer/lib/refusal.js";
import type { PlatformBridge } from "../platform/platform-bridge.js";
import { callDaemon } from "./daemon-reply.js";
import { refusalOf } from "@test/helpers/daemon-reply-refusal.js";
import { bridgeAnswering, createFixture } from "@test/helpers/fixture-bridge.js";

/**
 * The retry bound a refusal carries, read structurally: `DaemonReply.refusal` is typed
 * `Refusal`, and only the `WireRefusal` that `normalizeWireRejection` returns adds `retry`.
 */
function retryBoundOf(
  refusal: Refusal,
): { readonly afterSeconds?: number; readonly atEpochMilliseconds?: number } | undefined {
  return (
    refusal as {
      readonly retry?: { readonly afterSeconds?: number; readonly atEpochMilliseconds?: number };
    }
  ).retry;
}

describe("callDaemon — a rejection becomes a refusal and never an exception", () => {
  it("passes a typed wire envelope through verbatim", async () => {
    // The wire's `{code, message}` envelope is a plain object; a refusal reaches the renderer
    // in this shape as well as carried on an `Error`.
    const envelope: unknown = {
      code: "session.not_found",
      message: "no such session on this node",
    };
    const { bridge } = bridgeAnswering(async () => {
      throw envelope;
    });

    const refusal = refusalOf(await callDaemon(bridge, "presence.read", {}));

    expect(refusal.code).toBe("session.not_found");
    expect(refusal.detail).toBe("no such session on this node");
  });

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
    // Negative control: a `{ code: string }` guard would land on the generic console code.
    expect(refusal.code).not.toBe("call-rejected");
  });

  it("carries a rate-limit envelope's retry bound through to the caller", async () => {
    // The bound rides `data.fields`, which a `callDaemon` that never read `data` would miss.
    const throttled: unknown = {
      code: -32000,
      message: "too many reads",
      data: { type: "ratelimit.exceeded", fields: { retryAfter: 30 } },
    };
    const { bridge } = bridgeAnswering(async () => {
      throw throttled;
    });

    const refusal = refusalOf(await callDaemon(bridge, "presence.read", {}));

    expect(refusal.code).toBe("ratelimit.exceeded");
    expect(retryBoundOf(refusal)).toStrictEqual({ afterSeconds: 30 });
  });

  it("keeps a carried console refusal, origin and all", async () => {
    // The fixture bridge's own errors arrive this way; re-labeling one would lose its `origin`.
    const carried = refuse("fixture-bridge", "reply-unscripted", "the scenario scripts no reply");
    const { bridge } = bridgeAnswering(async () => {
      throw new RefusalError(carried);
    });

    const refusal = refusalOf(await callDaemon(bridge, "presence.read", {}));

    expect(refusal).toStrictEqual(carried);
  });

  it("keeps one that lost its prototype crossing a boundary", async () => {
    // A value that crossed a realm or a structured clone is a plain object, so an `instanceof`
    // test would silently replace its code with one this console invented.
    const carried = refuse("fixture-bridge", "reply-unscripted", "the scenario scripts no reply");
    const cloned: unknown = {
      name: "RefusalError",
      message: `${carried.origin}: ${carried.code}: ${carried.detail}`,
      refusal: carried,
    };
    const { bridge } = bridgeAnswering(async () => {
      throw cloned;
    });

    const refusal = refusalOf(await callDaemon(bridge, "presence.read", {}));

    expect(refusal).toStrictEqual(carried);
  });

  it("answers a refusal for a rejection whose own `refusal` getter throws", async () => {
    // Reading a member runs a getter, and one that throws does so inside the `catch`, past
    // every guard. Because `callDaemon` is `async`, that would surface as a rejected promise
    // callers have no `try` for; it must answer a refusal instead.
    class HostileRejection extends Error {
      public get refusal(): never {
        throw new Error("this getter is the defect");
      }
    }
    const { bridge } = bridgeAnswering(async () => {
      throw new HostileRejection("the socket went away");
    });

    const reply = await callDaemon(bridge, "presence.read", {});

    expect(refusalOf(reply).code).toBe("call-rejected");
  });

  it("names a rejection that carries nothing machine-readable", async () => {
    const { bridge } = bridgeAnswering(async () => {
      throw new Error("the socket went away");
    });

    const refusal = refusalOf(await callDaemon(bridge, "presence.read", {}));

    expect(refusal.code).toBe("call-rejected");
    expect(refusal.detail).toContain("presence.read");
  });

  it("survives a rejection that cannot be rendered at all", async () => {
    // A null-prototype object throws inside `String(...)`, and a refusal must not crash on the
    // value it describes. `callDaemon` hands the normalizer a fallback naming the method, so
    // nothing off the wire is quoted into the sentence.
    const hostile: unknown = Object.create(null);
    const { bridge } = bridgeAnswering(async () => {
      throw hostile;
    });

    const refusal = refusalOf(await callDaemon(bridge, "presence.read", {}));

    expect(refusal.code).toBe("call-rejected");
    expect(refusal.detail).toBe("presence.read was rejected.");
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
