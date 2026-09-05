// The reply chokepoint on the PARSE arm: what the door sends, and what it makes of
// what comes back.
//
// Every case drives the REAL `callDaemon` over the REAL registry against a REAL
// bridge — the shipped fixture, with one namespace member replaced so the suite can
// decide what the daemon answers with. A hand-rolled parser here would assert
// against a copy of the rule and pass with the shipped one deleted.
//
// The REJECTION arm is `daemon-reply.rejections.test.ts` beside this file. The two
// are separated because they are two claims about one function, and each is an
// enumeration in its own right: this one says a reply off the contract never
// reaches a surface and a request off the contract never reaches the wire; that one
// says no shape a rejection arrives in leaves the door as an exception. The two
// roles both suites play live in `daemon-reply.test-support.ts`.

import type { ParticipantId } from "@ai-sidekicks/contracts";

import { isConsoleRefusal } from "../core/index.js";
import { callDaemon, DAEMON_REPLY_REFUSAL_ORIGIN, describeFailingPaths } from "./daemon-reply.js";
import { refusalOf, SESSION_ID } from "./daemon-reply.test-support.js";
import { bridgeAnswering } from "./fixture-bridge.test-support.js";

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
