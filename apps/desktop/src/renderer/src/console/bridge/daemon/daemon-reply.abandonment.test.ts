// The call door's fourth settlement: a read nobody is waiting for.
//
// The PARSE arm is `daemon-reply.test.ts` and the REJECTION arm is
// `daemon-reply.rejections.test.ts`. This is the third claim about the same
// function, and it is its own enumeration: a read whose owner has gone puts nothing
// on the wire, waits for nothing, parses nothing, and reports the departure rather
// than a wire failure — while a call carrying no signal at all is untouched by any
// of it.
//
// "PARSES NOTHING" IS TWO CLAIMS AND NOT ONE, so the cases below make it twice. A
// reply arriving AFTER the abandonment loses the door's race and never reaches the
// parse. A reply arriving JUST BEFORE it WINS that race — so the
// settlement reads `settled`, the door's abort listener is already retired, and the
// departure lands one microtask later while the door's own frame is still waiting to
// be resumed. The second is invisible to every assertion the first can make, because
// the door was handed a settlement rather than an abandonment, and it is produced by
// an interleaving rather than by an event.
//
// EVERY CASE DRIVES THE REAL DOOR OVER A REAL BRIDGE, with `daemon.call` replaced by
// an arm the case decides and RECORDS. The record is what makes the strongest claim
// here checkable rather than asserted: "nothing was sent" is a statement about the
// bridge, and `calls` is the bridge's own account of what it was asked.
//
// AND THE MUTATION CONTROL IS PLANTED, not inferred. A door that quietly abandoned
// every call once any signal anywhere had aborted would pass every read case in this
// file. So the last case sends a MUTATION through the same door in the same tick,
// with a read line that has been abandoned standing beside it, and asserts the call
// was made and its reply parsed — which fails the moment the door reads a signal
// it was not handed.

import type { RunId } from "@ai-sidekicks/contracts";
import { describe, expect, it, vi } from "vitest";

import { callDaemon } from "./daemon-reply.js";
import { CONSOLE_DAEMON_METHOD_BINDINGS } from "./daemon-reply-registry.js";
import { refusalOf, SESSION_ID } from "./daemon-reply.test-support.js";
import { bridgeAnswering } from "../fixture/fixture-bridge.test-support.js";

/** The code the door raises for a read whose owner has gone. */
const READ_ABANDONED = "read-abandoned";

/** A run id the branded schema accepts, for the mutation control below. */
const RUN_ID = "019b79ee-0280-7f00-8110-a11ce0000002" as RunId;

/**
 * One read line, in the shape the door actually receives.
 *
 * A bare `AbortController` and NOT `ReadScope`, deliberately. What is under test here
 * is the door, whose contract is an `AbortSignal` and nothing narrower; driving the
 * scope instead would put a second module inside every assertion and make a failure
 * ambiguous between the two. The scope's own behaviour — that it aborts on unmount,
 * on re-address, and on supersession — is asserted where it lives, in
 * `store/read-cancellation.test.ts` and its hook suite beside it.
 */
function readLine(): AbortController {
  return new AbortController();
}

/** A reply the presence schema admits, so a served arm is reachable in these cases. */
function servedPresenceReply(): unknown {
  return { participants: [] };
}

/** A promise that never settles, and the release that lets a case settle it. */
function heldReply(): { readonly promise: Promise<unknown>; readonly release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<unknown>((resolve) => {
    release = () => resolve(servedPresenceReply());
  });
  return { promise, release };
}

/**
 * The registered reply schema the door itself resolves for the method these cases
 * send, named once so the spy below watches the real parser rather than a lookalike.
 */
const PRESENCE_REPLY_SCHEMA = CONSOLE_DAEMON_METHOD_BINDINGS["presence.read"].responseSchema;

/**
 * A reply that fulfils, and queues the abandonment BEHIND its own fulfilment.
 *
 * A HAND-WRITTEN THENABLE rather than a promise and a counted number of turns, and
 * the reason is that the interleaving under test is one microtask wide: the reply has
 * to win the door's race — retiring its abort listener as it settles — and the abort
 * has to land before the door's own `await` is resumed. Adopting a thenable calls
 * this `then` with the adopting promise's own resolver, so `settle` IS that
 * fulfilment and the `queueMicrotask` beside it is the first job queued after it.
 * Spelled instead as a resolved promise and some number of awaited turns, the same
 * case would be asserting how many microtasks a runtime spends adopting a promise,
 * which is a claim about the runtime rather than about this door — and one that
 * lands on the wrong arm the moment the answer changes.
 *
 * The cast is the seam every thenable needs: the bridge's call arm answers
 * `Promise<unknown>`, and `then` is the whole of that contract the language uses to
 * adopt one.
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

describe("callDaemon — a read whose owner has gone", () => {
  it("sends nothing when the line was already abandoned", async () => {
    const line = readLine();
    line.abort();
    const underTest = bridgeAnswering(async () => servedPresenceReply());

    const reply = await callDaemon(
      underTest.bridge,
      "presence.read",
      { sessionId: SESSION_ID },
      { signal: line.signal },
    );

    expect(refusalOf(reply).code).toBe(READ_ABANDONED);
    // The claim the record makes and an assertion on the reply alone cannot: the
    // bridge was never asked.
    expect(underTest.calls).toStrictEqual([]);
  });

  it("settles without waiting for a reply that never arrives", async () => {
    const line = readLine();
    const held = heldReply();
    const underTest = bridgeAnswering(async () => await held.promise);

    const calling = callDaemon(
      underTest.bridge,
      "presence.read",
      { sessionId: SESSION_ID },
      { signal: line.signal },
    );
    line.abort();

    const reply = await calling;

    expect(refusalOf(reply).code).toBe(READ_ABANDONED);
    // The call really was made — this is not the pre-send arm above — and it is still
    // outstanding as this assertion runs, which is the whole point of the race.
    expect(underTest.calls.map((call) => call.method)).toStrictEqual(["presence.read"]);
    held.release();
  });

  it("reads nothing from a reply that arrives after the abandonment", async () => {
    const line = readLine();
    const held = heldReply();
    const underTest = bridgeAnswering(async () => await held.promise);

    const calling = callDaemon(
      underTest.bridge,
      "presence.read",
      { sessionId: SESSION_ID },
      { signal: line.signal },
    );
    line.abort();
    // A reply the registered schema would REFUSE. A door that had gone on to parse it
    // would answer `reply-unreadable`, so the code below is evidence the parse never
    // ran rather than evidence that it ran and agreed.
    held.release();

    expect(refusalOf(await calling).code).toBe(READ_ABANDONED);
  });

  it("reports the departure rather than a wire failure when the call also rejected", async () => {
    const line = readLine();
    const underTest = bridgeAnswering(async () => {
      line.abort();
      throw new Error("the transport went away");
    });

    const reply = await callDaemon(
      underTest.bridge,
      "presence.read",
      { sessionId: SESSION_ID },
      { signal: line.signal },
    );

    expect(refusalOf(reply).code).toBe(READ_ABANDONED);
    expect(refusalOf(reply).detail).not.toContain("the transport went away");
  });

  it("parses nothing when the abandonment lands between the settlement and the resume", async () => {
    const line = readLine();
    const replyParse = vi.spyOn(PRESENCE_REPLY_SCHEMA, "safeParse");
    // A reply the schema ADMITS, on purpose: the case above proves the parse never
    // ran by handing over a reply the schema would refuse, and that evidence is only
    // available while the reply is refusable. Here the reply is one the door would
    // have served, so nothing about the ANSWER could distinguish a door that parsed
    // it from one that did not — which is what the spy is for.
    const underTest = bridgeAnswering(() =>
      replyFulfillingAheadOfTheAbandonment(servedPresenceReply(), line),
    );

    try {
      const reply = await callDaemon(
        underTest.bridge,
        "presence.read",
        { sessionId: SESSION_ID },
        { signal: line.signal },
      );

      expect(refusalOf(reply).code).toBe(READ_ABANDONED);
      expect(replyParse).not.toHaveBeenCalled();
      // The interleaving really was the one this case is about: the call was made,
      // and the line was abandoned after the reply had already settled the race.
      expect(underTest.calls.map((call) => call.method)).toStrictEqual(["presence.read"]);
      expect(line.signal.aborted).toBe(true);
    } finally {
      replyParse.mockRestore();
    }
  });

  it("negative control: that same spy sees the parse when the line stays live", async () => {
    // Without this the assertion above would be satisfied by a spy watching a schema
    // the door never reaches — a green result about the wrong object.
    const line = readLine();
    const replyParse = vi.spyOn(PRESENCE_REPLY_SCHEMA, "safeParse");
    const underTest = bridgeAnswering(async () => servedPresenceReply());

    try {
      const reply = await callDaemon(
        underTest.bridge,
        "presence.read",
        { sessionId: SESSION_ID },
        { signal: line.signal },
      );

      expect(reply.status).toBe("served");
      expect(replyParse).toHaveBeenCalledTimes(1);
    } finally {
      replyParse.mockRestore();
    }
  });

  it("serves a read whose line is still live", async () => {
    const line = readLine();
    const underTest = bridgeAnswering(async () => servedPresenceReply());

    const reply = await callDaemon(
      underTest.bridge,
      "presence.read",
      { sessionId: SESSION_ID },
      { signal: line.signal },
    );

    // The negative control for every case above: with the same door, the same bridge,
    // and the same request, a live line is served. Without it "the read was abandoned"
    // would be satisfied by a door that abandoned everything.
    expect(reply.status).toBe("served");
    expect(underTest.calls.map((call) => call.method)).toStrictEqual(["presence.read"]);
  });
});

describe("callDaemon — a mutation is never abandoned", () => {
  it("performs and parses a call that was handed no signal, beside an abandoned line", async () => {
    // The planted control. A read line exists and is abandoned in the same tick, and
    // the mutation below carries no reference to it — which is exactly the shape a run
    // control has, since the console's run-control dispatch takes no round and has no
    // parameter to put one in.
    const abandonedLine = readLine();
    abandonedLine.abort();

    const underTest = bridgeAnswering(async () => ({
      runId: RUN_ID,
      currentState: "paused",
      runVersion: 2,
    }));

    const reply = await callDaemon(underTest.bridge, "run.pause", {
      targetRunId: RUN_ID,
      expectedRunVersion: 1,
    });

    expect(underTest.calls.map((call) => call.method)).toStrictEqual(["run.pause"]);
    // Served, and served through the registry's own parse. A door that read some
    // ambient signal would answer `read-abandoned` here instead.
    expect(reply.status).toBe("served");
    expect(abandonedLine.signal.aborted).toBe(true);
  });
});
