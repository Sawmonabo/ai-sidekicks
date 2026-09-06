// The call door's fourth settlement: a read nobody is waiting for.
//
// The PARSE arm is `daemon-reply.test.ts` and the REJECTION arm is
// `daemon-reply.rejections.test.ts`. This is the third claim about the same
// function, and it is its own enumeration: a read whose owner has gone puts nothing
// on the wire, waits for nothing, parses nothing, and reports the departure rather
// than a wire failure — while a call carrying no signal at all is untouched by any
// of it.
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
import { describe, expect, it } from "vitest";

import { callDaemon } from "./daemon-reply.js";
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
