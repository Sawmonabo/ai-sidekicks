// `callDaemon`'s fourth settlement: a read nobody is waiting for. A read whose owner has gone puts
// nothing on the wire, waits for nothing, parses nothing, and reports the departure, while a call
// with no signal is untouched. Every case drives the real `callDaemon` over a bridge whose `calls`
// record makes "nothing was sent" checkable.
//
// "Parses nothing" is two claims. A reply arriving after the abandonment loses the race; a reply
// arriving just before wins it, so the settlement reads `settled` and the departure lands one
// microtask later. The last case is the mutation control: a mutation sent beside an abandoned read
// line must still be made and parsed, which fails if `callDaemon` reads a signal it was not handed.

import type { RunId } from "@ai-sidekicks/contracts";
import { describe, expect, it, vi } from "vitest";

import { callDaemon } from "./daemon-reply.js";
import { DAEMON_METHOD_BINDINGS } from "./daemon-reply-registry.js";
import { refusalOf } from "@test/helpers/daemon-reply-refusal.js";
import { bridgeAnswering } from "@test/helpers/fixture-bridge.js";

/** The code `callDaemon` raises for a read whose owner has gone. */
const READ_ABANDONED = "read-abandoned";

/** A run id the branded schema accepts, for the mutation control below. */
const RUN_ID = "019b79ee-0280-7f00-8110-a11ce0000002" as RunId;

/**
 * One read line, as a bare `AbortController` rather than `ReadScope`: `callDaemon`'s contract is
 * an `AbortSignal`, and a scope would make a failure ambiguous. The scope's own behavior is
 * asserted in `lib/reads/read-scope.test.ts` and `hooks/useReadScope.test.tsx`.
 */
function readLine(): AbortController {
  return new AbortController();
}

/** A reply the presence schema admits, so a served arm is reachable in these cases. */
function servedPresenceReply(): unknown {
  return { devices: [] };
}

/**
 * A reply the presence schema refuses, so a parse that ran shows as `reply-unreadable`; the
 * negative control beside the late-reply case proves a live line settles that way.
 */
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

describe("callDaemon — a read whose owner has gone", () => {
  it("sends nothing when the line was already abandoned", async () => {
    const line = readLine();
    line.abort();
    const underTest = bridgeAnswering(async () => servedPresenceReply());

    const reply = await callDaemon(underTest.bridge, "presence.read", {}, { signal: line.signal });

    expect(refusalOf(reply).code).toBe(READ_ABANDONED);
    // The bridge was never asked, which the reply alone cannot show.
    expect(underTest.calls).toStrictEqual([]);
  });

  it("settles without waiting for a reply that never arrives", async () => {
    const line = readLine();
    // The body is immaterial here, but refusable so no case passes for a `callDaemon` that
    // read what it was handed.
    const held = heldReply(refusedPresenceReply());
    const underTest = bridgeAnswering(async () => await held.promise);

    const calling = callDaemon(underTest.bridge, "presence.read", {}, { signal: line.signal });
    line.abort();

    const reply = await calling;

    expect(refusalOf(reply).code).toBe(READ_ABANDONED);
    // The call was made (this is not the pre-send arm) and is still outstanding here.
    expect(underTest.calls.map((call) => call.method)).toStrictEqual(["presence.read"]);
    held.release();
  });

  it("reads nothing from a reply that arrives after the abandonment", async () => {
    const line = readLine();
    // A refusable reply: a `callDaemon` that parsed it would answer `reply-unreadable`, so the
    // code below shows the parse never ran, which a valid body could not.
    const held = heldReply(refusedPresenceReply());
    const underTest = bridgeAnswering(async () => await held.promise);

    const calling = callDaemon(underTest.bridge, "presence.read", {}, { signal: line.signal });
    line.abort();
    held.release();

    expect(refusalOf(await calling).code).toBe(READ_ABANDONED);
  });

  it("negative control: that same reply answers `reply-unreadable` on a live line", async () => {
    // Control for the case above: dropping the guard between the race and the parse turns it
    // red with this code, and it shows the body is refusable at all.
    const line = readLine();
    const underTest = bridgeAnswering(async () => refusedPresenceReply());

    const reply = await callDaemon(underTest.bridge, "presence.read", {}, { signal: line.signal });

    expect(refusalOf(reply).code).toBe("reply-unreadable");
  });

  it("reports the departure rather than a wire failure when the call also rejected", async () => {
    const line = readLine();
    const underTest = bridgeAnswering(async () => {
      line.abort();
      throw new Error("the transport went away");
    });

    const reply = await callDaemon(underTest.bridge, "presence.read", {}, { signal: line.signal });

    expect(refusalOf(reply).code).toBe(READ_ABANDONED);
    expect(refusalOf(reply).detail).not.toContain("the transport went away");
  });

  it("parses nothing when the abandonment lands between the settlement and the resume", async () => {
    const line = readLine();
    const replyParse = vi.spyOn(PRESENCE_REPLY_SCHEMA, "safeParse");
    // A reply the schema admits, on purpose: the answer cannot distinguish a `callDaemon` that
    // parsed it from one that did not, which is what the spy is for.
    const underTest = bridgeAnswering(() =>
      replyFulfillingAheadOfTheAbandonment(servedPresenceReply(), line),
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

  it("negative control: that same spy sees the parse when the line stays live", async () => {
    // Without it, the assertion above passes for a spy watching a schema `callDaemon` never
    // reaches.
    const line = readLine();
    const replyParse = vi.spyOn(PRESENCE_REPLY_SCHEMA, "safeParse");
    const underTest = bridgeAnswering(async () => servedPresenceReply());

    try {
      const reply = await callDaemon(
        underTest.bridge,
        "presence.read",
        {},
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

    const reply = await callDaemon(underTest.bridge, "presence.read", {}, { signal: line.signal });

    // Negative control for every case above: a `callDaemon` that abandoned everything would
    // otherwise pass.
    expect(reply.status).toBe("served");
    expect(underTest.calls.map((call) => call.method)).toStrictEqual(["presence.read"]);
  });
});

describe("callDaemon — a mutation is never abandoned", () => {
  it("performs and parses a call that was handed no signal, beside an abandoned line", async () => {
    // The mutation carries no reference to the abandoned line, as a run control has no
    // parameter to carry one.
    const abandonedLine = readLine();
    abandonedLine.abort();

    const underTest = bridgeAnswering(async () => ({}));

    const reply = await callDaemon(underTest.bridge, "driver.interruptRun", { runId: RUN_ID });

    expect(underTest.calls.map((call) => call.method)).toStrictEqual(["driver.interruptRun"]);
    // Served through the registry's parse; a `callDaemon` reading an ambient signal would answer
    // `read-abandoned`.
    expect(reply.status).toBe("served");
    expect(abandonedLine.signal.aborted).toBe(true);
  });
});
