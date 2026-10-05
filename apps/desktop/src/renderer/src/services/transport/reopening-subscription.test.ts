// A stream kept open for its owner, on a manual clock: one that delivers and ends at once is
// opened again at once and then after growing waits, and from the first wait again once a stream
// stays open. A re-open that throws reaches the owner as a refusal, is tried again at the next
// wait or the transport's returning edge, and is cleared by the re-open that works; an owner that
// asks for it has a first open that throws handled the same way.

import { describe, expect, it, vi } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import type { Refusal } from "@renderer/lib/refusal.js";
import {
  openReopeningSubscription,
  REOPEN_SETTLED_MS,
  REOPEN_WAITS_MS,
  type ReopenableStreamOpen,
} from "./reopening-subscription.js";
import { TransportReconnectSignal } from "./transport-reconnect.js";

/** A daemon stream played by the test: each open it took, and how many next opens throw. */
class ScriptedStream {
  public readonly opens: Array<{ readonly deliverAndEnd: () => void }> = [];
  public failingOpens = 0;

  public readonly open: ReopenableStreamOpen<string> = (deliver, onEnded) => {
    if (this.failingOpens > 0) {
      this.failingOpens -= 1;
      throw new Error("the stream could not open");
    }
    this.opens.push({
      deliverAndEnd: () => {
        deliver("value");
        onEnded({ reason: "completed" });
      },
    });
    return () => undefined;
  };

  /** The newest open delivers one value and ends. */
  public deliverAndEnd(): void {
    this.opens.at(-1)!.deliverAndEnd();
  }
}

describe("a stream kept open", () => {
  it("opens a stream that ends at once again at once, then after growing waits, then afresh once one lasts", () => {
    const clock = new ManualClock();
    const stream = new ScriptedStream();
    openReopeningSubscription({
      signal: new TransportReconnectSignal(),
      subject: "test stream",
      open: stream.open,
      onFrame: () => undefined,
      clock,
    });

    stream.deliverAndEnd();
    expect(stream.opens).toHaveLength(2);
    for (const [step, waitMs] of REOPEN_WAITS_MS.slice(1, 4).entries()) {
      stream.deliverAndEnd();
      clock.advance(waitMs - 1);
      expect(stream.opens).toHaveLength(2 + step);
      clock.advance(1);
      expect(stream.opens).toHaveLength(3 + step);
    }

    clock.advance(REOPEN_SETTLED_MS);
    stream.deliverAndEnd();

    expect(stream.opens).toHaveLength(6);
  });

  it("reports a re-open that throws as a refusal, tries it again, and clears it when one works", () => {
    const clock = new ManualClock();
    const signal = new TransportReconnectSignal();
    const stream = new ScriptedStream();
    const refusals: Array<Refusal | undefined> = [];
    const onReopened = vi.fn();
    openReopeningSubscription({
      signal,
      subject: "test stream",
      open: stream.open,
      onFrame: () => undefined,
      onReopened,
      onReopenRefusal: (refusal) => {
        refusals.push(refusal);
      },
      clock,
    });
    stream.failingOpens = 2;

    stream.deliverAndEnd();
    expect(refusals).toStrictEqual([
      expect.objectContaining({
        detail: "Live updates stopped and could not start again; still trying.",
      }),
    ]);
    // Tried again at the next wait, and refused again.
    clock.advance(REOPEN_WAITS_MS[1]!);
    expect(refusals).toHaveLength(2);
    // The returning edge comes before the wait after that, and the re-open works.
    signal.observe("reachable");

    expect(stream.opens).toHaveLength(2);
    expect(refusals.at(-1)).toBeUndefined();
    expect(onReopened).toHaveBeenCalledOnce();
    expect(clock.pendingCount).toBe(0);
  });

  it("reports a first open that throws as a refusal and tries it again with no returning edge", () => {
    const clock = new ManualClock();
    const stream = new ScriptedStream();
    stream.failingOpens = 1;
    const refusals: Array<Refusal | undefined> = [];
    openReopeningSubscription({
      signal: new TransportReconnectSignal(),
      subject: "test stream",
      open: stream.open,
      onFrame: () => undefined,
      onReopenRefusal: (refusal) => {
        refusals.push(refusal);
      },
      firstOpenFailure: "refuseAndRetry",
      clock,
    });
    expect(refusals).toStrictEqual([
      expect.objectContaining({ detail: "Live updates could not start; still trying." }),
    ]);

    clock.advance(REOPEN_WAITS_MS[1]!);
    expect(stream.opens).toHaveLength(1);
    expect(refusals.at(-1)).toBeUndefined();
  });
});
