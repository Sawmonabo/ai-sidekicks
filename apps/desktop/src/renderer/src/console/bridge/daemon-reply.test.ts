// The reply chokepoint, asserted on both directions and on every refusal arm.
//
// Every case drives the REAL `callDaemon` over the REAL registry against a REAL
// bridge — the shipped fixture, with one namespace member replaced so the suite can
// decide what the daemon answers with. A hand-rolled parser here would assert
// against a copy of the rule and pass with the shipped one deleted.

import type { ParticipantId, SessionId } from "@ai-sidekicks/contracts";

import {
  ConsoleRefusalError,
  isConsoleRefusal,
  refuse,
  type ConsoleRefusal,
} from "../core/index.js";
import type { ConsoleBridge } from "./console-bridge.js";
import {
  callDaemon,
  DAEMON_REPLY_REFUSAL_ORIGIN,
  describeFailingPaths,
  type DaemonReply,
} from "./daemon-reply.js";
import { createFixtureBridge } from "./fixture-bridge.js";
import { FLAGSHIP_SCENARIO } from "./scenarios/flagship.js";

/**
 * A session id the branded schema accepts, taken from a shipped scenario.
 *
 * The cast is the scenario manifest's seam, not this suite's shortcut: a scenario
 * declares `sessionId` as a plain `string` because it is authored data, and the
 * request schema brands it. `fixture-bridge.relay.test.ts` widens the same value
 * the same way for the same reason. The value still has to satisfy the branded
 * SCHEMA at run time — every case here parses through it — so a cast to a
 * malformed id fails the assertion rather than slipping past it.
 */
const SESSION_ID = FLAGSHIP_SCENARIO.sessionId as SessionId;

/** A participant id the branded schema accepts. Same seam, same run-time check. */
const PARTICIPANT_ID = "019b79ee-0280-7f00-8110-a11ce0000001" as ParticipantId;

/** An RFC 3339 instant the response schema accepts. */
const SEEN_AT = "2026-01-01T14:20:00.500Z";

/**
 * A value the response schema rejects, spelled so a leak is unmistakable.
 *
 * Shaped like the participant content rule 9 forbids in a refusal detail, so the
 * assertion that it is absent reads as the claim it is making.
 */
const OFF_CONTRACT = "the participant said something private";

/** What the daemon was asked, so a case can assert it was never asked at all. */
interface RecordedCall {
  readonly method: string;
  readonly params: unknown;
}

interface BridgeUnderTest {
  readonly bridge: ConsoleBridge;
  readonly calls: readonly RecordedCall[];
}

/**
 * The shipped fixture bridge with its `daemon.call` replaced by one this suite
 * decides the answer for.
 *
 * A spread over a real bridge, which is the console's established shape for driving
 * one namespace member (`palette/bridge-commands.test.tsx`). That the rest is real
 * matters: `callDaemon` reaches the wire through `bridge.sidekicks.daemon.call` and
 * nothing else, so a case passing against a hand-built object would not prove it
 * reached a bridge at all.
 */
function bridgeAnswering(answer: (call: RecordedCall) => Promise<unknown>): BridgeUnderTest {
  const calls: RecordedCall[] = [];
  const fixture = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
  return { bridge: withDaemonCall(fixture, answer, calls), calls };
}

/** One bridge whose call arm is this suite's, and whose every other arm is real. */
function withDaemonCall(
  fixture: ConsoleBridge,
  answer: (call: RecordedCall) => Promise<unknown>,
  calls: RecordedCall[],
): ConsoleBridge {
  return {
    ...fixture,
    sidekicks: {
      ...fixture.sidekicks,
      daemon: {
        ...fixture.sidekicks.daemon,
        call: (async (method: string, params: unknown): Promise<unknown> => {
          const recorded: RecordedCall = { method, params };
          calls.push(recorded);
          return answer(recorded);
        }) as ConsoleBridge["sidekicks"]["daemon"]["call"],
      },
    },
  };
}

/** The refusal a reply carries, or a failure naming what it carried instead. */
function refusalOf(reply: DaemonReply<unknown>): ConsoleRefusal {
  if (reply.status !== "refused") {
    throw new Error(`expected a refusal and the call was served with ${JSON.stringify(reply)}`);
  }
  return reply.refusal;
}

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

/** One served presence reply, in the shape the registered schema admits. */
function servedPresenceReply(lastSeen: string, count = 1): unknown {
  return {
    participants: Array.from({ length: count }, () => ({
      participantId: PARTICIPANT_ID,
      state: "online",
      lastSeen,
    })),
  };
}

describe("callDaemon — a served reply is a parsed reply", () => {
  it("serves the registered shape the daemon answered with", async () => {
    const { bridge, calls } = bridgeAnswering(async () => servedPresenceReply(SEEN_AT));

    const reply = await callDaemon(bridge, "presence.read", { sessionId: SESSION_ID });

    expect(calls).toStrictEqual([{ method: "presence.read", params: { sessionId: SESSION_ID } }]);
    expect(reply.status).toBe("served");
    if (reply.status === "served") {
      // Read through the response TYPE the registry binds, so a row pointing at the
      // wrong schema fails this file at compile time and not only at run time.
      expect(reply.value.participants[0]?.participantId).toBe(PARTICIPANT_ID);
    }
  });

  it("negative control: the same call refuses when one member is off-contract", async () => {
    // Without this, the case above would pass for a `callDaemon` that parsed nothing
    // and handed the reply straight back.
    const { bridge } = bridgeAnswering(async () => ({
      participants: [{ participantId: PARTICIPANT_ID, state: "loitering", lastSeen: SEEN_AT }],
    }));

    const reply = await callDaemon(bridge, "presence.read", { sessionId: SESSION_ID });

    expect(refusalOf(reply).code).toBe("reply-unreadable");
  });
});

describe("callDaemon — a reply the contract does not admit is a refusal", () => {
  it("refuses an entirely wrong reply under the console's own code and origin", async () => {
    const { bridge } = bridgeAnswering(async () => ({ rows: [] }));

    const refusal = refusalOf(await callDaemon(bridge, "presence.read", { sessionId: SESSION_ID }));

    expect(refusal.code).toBe("reply-unreadable");
    expect(refusal.origin).toBe(DAEMON_REPLY_REFUSAL_ORIGIN);
    expect(refusal.detail).toContain("presence.read");
    expect(isConsoleRefusal(refusal)).toBe(true);
  });

  it("names the failing member path", async () => {
    const { bridge } = bridgeAnswering(async () => servedPresenceReply(OFF_CONTRACT));

    const refusal = refusalOf(await callDaemon(bridge, "presence.read", { sessionId: SESSION_ID }));

    expect(refusal.detail).toContain("participants.0.lastSeen");
  });

  it("never puts the refused VALUE in the sentence a person reads", async () => {
    // Rule 9's non-negotiable half, and the reason this module composes its own
    // sentence instead of rendering the validator's: a rejected member can be a
    // participant's words, a repo path, or an invite token, and the validator
    // interpolates it. Both per-family parsers this replaces stringified the error
    // straight into the detail.
    const { bridge } = bridgeAnswering(async () => servedPresenceReply(OFF_CONTRACT));

    const refusal = refusalOf(await callDaemon(bridge, "presence.read", { sessionId: SESSION_ID }));

    expect(refusal.detail).not.toContain(OFF_CONTRACT);
  });

  it("bounds how many paths it names", async () => {
    // A reply wrong in twelve places is wrong in one way. The cap is what keeps the
    // detail a sentence; without it the refusal card renders a list.
    const { bridge } = bridgeAnswering(async () => servedPresenceReply(OFF_CONTRACT, 12));

    const refusal = refusalOf(await callDaemon(bridge, "presence.read", { sessionId: SESSION_ID }));

    expect(refusal.detail).toContain("and more");
    expect(refusal.detail.match(/participants\.\d+\.lastSeen/gu)).toHaveLength(3);
  });
});

describe("callDaemon — a request the contract does not admit is never sent", () => {
  it("refuses before the call, and the daemon sees nothing", async () => {
    const { bridge, calls } = bridgeAnswering(async () => servedPresenceReply(SEEN_AT));

    // The branded id is a compile-time marker over an opaque string, so a caller CAN
    // hand this seam a value the wire would refuse; the parse is what stops it
    // becoming a round trip that fails.
    const refusal = refusalOf(
      await callDaemon(bridge, "presence.read", {
        sessionId: "not-a-session-id" as typeof SESSION_ID,
      }),
    );

    expect(refusal.code).toBe("request-unsendable");
    expect(refusal.origin).toBe(DAEMON_REPLY_REFUSAL_ORIGIN);
    expect(refusal.detail).toContain("presence.read");
    expect(calls).toStrictEqual([]);
  });

  it("what reaches the daemon is the parser's output, not the caller's object", async () => {
    // The parsed request travels. A forwarded reference would let a caller keep
    // mutating an object the console had already declared sendable, and would leave
    // any member the schema normalises un-normalised on the wire.
    const { bridge, calls } = bridgeAnswering(async () => servedPresenceReply(SEEN_AT));
    const request = { sessionId: SESSION_ID };

    await callDaemon(bridge, "presence.read", request);

    expect(calls[0]?.params).toStrictEqual(request);
    expect(calls[0]?.params).not.toBe(request);
  });
});

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
    const fixture = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO });
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

describe("describeFailingPaths — a shape it cannot read yields no clause", () => {
  // Driven directly rather than through the door, because the door's own callers
  // always hand it a real validator error: the parameter is typed `unknown`
  // precisely to disclaim that knowledge, and a claim that only holds for the one
  // shape the one caller passes is not the claim the signature makes.

  it("answers an empty clause for the two values a property read throws on", () => {
    expect(describeFailingPaths(null)).toBe("");
    expect(describeFailingPaths(undefined)).toBe("");
  });

  it("answers an empty clause when reading `issues` throws", () => {
    const hostile: unknown = {
      get issues(): never {
        throw new Error("this getter is the defect");
      },
    };

    expect(describeFailingPaths(hostile)).toBe("");
  });

  it("skips an issue whose own `path` cannot be read, and keeps the rest", () => {
    const mixed: unknown = {
      issues: [
        {
          get path(): never {
            throw new Error("this getter is the defect");
          },
        },
        { path: ["participants", 0, "lastSeen"] },
      ],
    };

    expect(describeFailingPaths(mixed)).toBe(" (at participants.0.lastSeen)");
  });

  it("names a segment it cannot render rather than throwing on it", () => {
    // A path segment is whatever the validator put there. `String(...)` runs
    // ToPrimitive, which throws on a null-prototype value carrying no `toString`,
    // so the segment goes through the family's total stringifier and the clause
    // says the segment is unrenderable instead of taking the sentence down.
    const unrenderable: unknown = { issues: [{ path: [Object.create(null)] }] };

    expect(describeFailingPaths(unrenderable)).toBe(" (at [unrepresentable value])");
  });

  it("negative control: an ordinary validator error still names its members", () => {
    // Without this, a guard that answered `""` for everything would pass all four
    // cases above and silently delete the clause from every refusal sentence.
    const error: unknown = { issues: [{ path: ["participants", 0, "state"] }] };

    expect(describeFailingPaths(error)).toBe(" (at participants.0.state)");
  });
});
