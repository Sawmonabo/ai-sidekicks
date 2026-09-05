// The reply chokepoint on the REJECTION arm: every way a call can fail becomes a
// refusal, and none of them becomes an exception.
//
// Every case drives the REAL `callDaemon` over the REAL registry against a REAL
// bridge — the shipped fixture, with one namespace member replaced so the suite can
// decide how the daemon fails. A hand-rolled normalizer here would assert against a
// copy of the rule and pass with the shipped one deleted.
//
// The claim is TOTAL, so the cases are an ENUMERATION of the shapes a rejection
// arrives in — a typed wire envelope, a JSON-RPC remote error carrying its dotted
// code under `data`, a rate-limit bound, a carried console refusal, one that lost
// its prototype crossing a boundary, one whose own getter throws, one carrying
// nothing machine-readable, one that cannot be rendered at all, and a bridge that
// throws in the caller's own frame. A shape missing from this list is a shape that
// reaches a surface as a crash.
//
// The PARSE arm is `daemon-reply.test.ts` beside this file, and the two roles both
// suites play live in `daemon-reply.test-support.ts`.

import { ConsoleRefusalError, refuse, type ConsoleRefusal } from "../core/index.js";
import type { ConsoleBridge } from "./console-bridge.js";
import { callDaemon } from "./daemon-reply.js";
import { refusalOf, SESSION_ID } from "./daemon-reply.test-support.js";
import { bridgeAnswering, createFixture } from "./fixture-bridge.test-support.js";

/**
 * The retry bound a refusal carries, read structurally.
 *
 * `DaemonReply.refusal` is typed `ConsoleRefusal` on purpose — a surface renders a
 * refusal, and only one offering a retry has to know the member exists — while
 * `normalizeWireRejection` answers the `WireRefusal` that widens it by exactly this
 * optional member. Read here rather than imported so this suite does not become the
 * one consumer that retires the `@consumedBy` marker `core/index.ts` carries for a
 * type no surface reads yet.
 */
function retryBoundOf(
  refusal: ConsoleRefusal,
): { readonly afterSeconds?: number; readonly atEpochMilliseconds?: number } | undefined {
  return (
    refusal as {
      readonly retry?: { readonly afterSeconds?: number; readonly atEpochMilliseconds?: number };
    }
  ).retry;
}

describe("callDaemon — a rejection becomes a refusal and never an exception", () => {
  it("passes a typed wire envelope through verbatim", async () => {
    // The wire's own `{code, message}` envelope is a plain object;
    // `src/shared/wire-errors.ts` records that a refusal reaches a renderer in
    // exactly this shape as well as carried on an `Error`.
    const envelope: unknown = {
      code: "session.not_found",
      message: "no such session on this node",
    };
    const { bridge } = bridgeAnswering(async () => {
      throw envelope;
    });

    const refusal = refusalOf(await callDaemon(bridge, "presence.read", { sessionId: SESSION_ID }));

    expect(refusal.code).toBe("session.not_found");
    expect(refusal.detail).toBe("no such session on this node");
  });

  it("keeps the daemon's own dotted code off a JSON-RPC rejection", async () => {
    // The arm that decides whether this door is a consumer of the console's one
    // normalizer or an eleventh copy of it. `JsonRpcRemoteError` carries the
    // JSON-RPC NUMERIC as `code` and the project's dotted code at `data.type`,
    // which `packages/contracts` states callers must discriminate on — so a door
    // guarding on `{ code: string }` sees a number, misses, and renders every
    // registered daemon refusal as one generic console code.
    const remote = Object.assign(new Error("no such session on this node"), {
      code: -32603,
      data: { type: "session.not_found" },
    });
    const { bridge } = bridgeAnswering(async () => {
      throw remote;
    });

    const refusal = refusalOf(await callDaemon(bridge, "presence.read", { sessionId: SESSION_ID }));

    expect(refusal.code).toBe("session.not_found");
    expect(refusal.detail).toBe("no such session on this node");
    // Negative control on the body this door used to carry: it landed exactly here,
    // on the console's own generic code, with the daemon's on the floor.
    expect(refusal.code).not.toBe("call-rejected");
  });

  it("carries a rate-limit envelope's retry bound through to the caller", async () => {
    // A bound the refusing side named is the difference between "try again in
    // thirty seconds" and a surface that offers a retry it cannot time. It rides
    // `data.fields`, which a door that never reads `data` at all cannot see.
    const throttled: unknown = {
      code: -32000,
      message: "too many reads",
      data: { type: "ratelimit.exceeded", fields: { retryAfter: 30 } },
    };
    const { bridge } = bridgeAnswering(async () => {
      throw throttled;
    });

    const refusal = refusalOf(await callDaemon(bridge, "presence.read", { sessionId: SESSION_ID }));

    expect(refusal.code).toBe("ratelimit.exceeded");
    expect(retryBoundOf(refusal)).toStrictEqual({ afterSeconds: 30 });
  });

  it("keeps a carried console refusal, origin and all", async () => {
    // The fixture bridge's own errors arrive this way. Re-labelling one would lose
    // the subsystem it names, which is the whole point of `origin`.
    const carried = refuse("fixture-bridge", "reply-unscripted", "the scenario scripts no reply");
    const { bridge } = bridgeAnswering(async () => {
      throw new ConsoleRefusalError(carried);
    });

    const refusal = refusalOf(await callDaemon(bridge, "presence.read", { sessionId: SESSION_ID }));

    expect(refusal).toStrictEqual(carried);
  });

  it("keeps one that lost its prototype crossing a boundary", async () => {
    // What makes the unwrap STRUCTURAL rather than an `instanceof` check: a value
    // that crossed a realm or a structured clone is a plain object carrying the
    // same member, and a prototype test drops its author's code silently — the
    // failure mode nothing reports, because the refusal still renders, under a
    // code this console invented.
    const carried = refuse("fixture-bridge", "reply-unscripted", "the scenario scripts no reply");
    const cloned: unknown = {
      name: "ConsoleRefusalError",
      message: `${carried.origin}: ${carried.code}: ${carried.detail}`,
      refusal: carried,
    };
    const { bridge } = bridgeAnswering(async () => {
      throw cloned;
    });

    const refusal = refusalOf(await callDaemon(bridge, "presence.read", { sessionId: SESSION_ID }));

    expect(refusal).toStrictEqual(carried);
  });

  it("answers a refusal for a rejection whose own `refusal` getter throws", async () => {
    // The totality claim in this module's header, held against the one value that
    // can break it: reading a member runs a getter, and a getter that throws does
    // it INSIDE the `catch` — past every guard, in the one function whose contract
    // is that it returns a refusal rather than throwing. An `async` function turns
    // that into a rejected promise from the door every caller took so it would not
    // need a `try` of its own.
    class HostileRejection extends Error {
      public get refusal(): never {
        throw new Error("this getter is the defect");
      }
    }
    const { bridge } = bridgeAnswering(async () => {
      throw new HostileRejection("the socket went away");
    });

    const reply = await callDaemon(bridge, "presence.read", { sessionId: SESSION_ID });

    expect(refusalOf(reply).code).toBe("call-rejected");
  });

  it("names a rejection that carries nothing machine-readable", async () => {
    const { bridge } = bridgeAnswering(async () => {
      throw new Error("the socket went away");
    });

    const refusal = refusalOf(await callDaemon(bridge, "presence.read", { sessionId: SESSION_ID }));

    expect(refusal.code).toBe("call-rejected");
    expect(refusal.detail).toContain("presence.read");
  });

  it("survives a rejection that cannot be rendered at all", async () => {
    // A null-prototype object throws inside `String(...)`. A refusal is a rendering
    // surface, so it must not be the thing that crashes on the value it exists to
    // describe. The sentence names the method and never the value: this door hands
    // the normalizer a fallback, so the terminal stringifier is not reached and
    // nothing off the wire is quoted into a sentence a person reads.
    const hostile: unknown = Object.create(null);
    const { bridge } = bridgeAnswering(async () => {
      throw hostile;
    });

    const refusal = refusalOf(await callDaemon(bridge, "presence.read", { sessionId: SESSION_ID }));

    expect(refusal.code).toBe("call-rejected");
    expect(refusal.detail).toBe("presence.read was rejected.");
  });

  it("returns a refusal for a bridge that throws in the caller's own frame", async () => {
    // The bridge that actually ships is the Tier-1 preload stub, and it throws
    // synchronously. A non-`async` wrapper would put that throw outside the promise
    // and past every `.catch` in the console.
    //
    // Overridden here rather than through `withDaemonCall`, and that is the case
    // itself: the shared arm is `async`, so a throw inside it is already a
    // rejection, which is the one thing this case must not assert.
    const fixture = createFixture().bridge;
    const bridge: ConsoleBridge = {
      ...fixture,
      sidekicks: {
        ...fixture.sidekicks,
        daemon: {
          ...fixture.sidekicks.daemon,
          call: (() => {
            throw new Error("the preload did not install a handler");
          }) as ConsoleBridge["sidekicks"]["daemon"]["call"],
        },
      },
    };

    const refusal = refusalOf(await callDaemon(bridge, "presence.read", { sessionId: SESSION_ID }));

    expect(refusal.code).toBe("call-rejected");
  });
});
