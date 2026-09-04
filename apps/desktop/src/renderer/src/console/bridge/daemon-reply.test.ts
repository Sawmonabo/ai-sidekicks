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
import { callDaemon, DAEMON_REPLY_REFUSAL_ORIGIN, type DaemonReply } from "./daemon-reply.js";
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
    // describe.
    const hostile: unknown = Object.create(null);
    const { bridge } = bridgeAnswering(async () => {
      throw hostile;
    });

    const refusal = refusalOf(await callDaemon(bridge, "presence.read", { sessionId: SESSION_ID }));

    expect(refusal.code).toBe("call-rejected");
    expect(refusal.detail).toContain("[unrepresentable value]");
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
