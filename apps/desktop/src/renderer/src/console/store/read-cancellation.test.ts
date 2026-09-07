// The read line's two endings, and the combinator that races them.
//
// Every case here drives the real `ReadScope` and the real `settleUnlessAbandoned`.
// The negative controls are the point rather than a formality: a scope that never
// aborted would pass a "the signal is live" assertion just as well as one that
// works, so each abort case is paired with the reading taken before it.

import { describe, expect, it } from "vitest";

import { ReadScope, settleUnlessAbandoned } from "./read-cancellation.js";

/** A promise that never settles, and the release that lets a case settle it. */
function heldPromise<TValue>(): {
  readonly promise: Promise<TValue>;
  readonly resolveWith: (value: TValue) => void;
  readonly rejectWith: (rejection: unknown) => void;
} {
  let resolveWith: (value: TValue) => void = () => undefined;
  let rejectWith: (rejection: unknown) => void = () => undefined;
  const promise = new Promise<TValue>((resolve, reject) => {
    resolveWith = resolve;
    rejectWith = reject;
  });
  return { promise, resolveWith, rejectWith };
}

describe("ReadScope — one read line, two endings", () => {
  it("opens a live round", () => {
    const scope = new ReadScope();
    const round = scope.openRound();
    expect(round.signal.aborted).toBe(false);
    expect(round.isCurrent).toBe(true);
    expect(scope.isAbandoned).toBe(false);
  });

  it("supersedes the previous round when a newer read opens", () => {
    const scope = new ReadScope();
    const superseded = scope.openRound();
    // The negative control: before the second round exists, the first is live on
    // both readings, so the assertions below are about the supersede and not about
    // a scope that was born aborted.
    expect(superseded.signal.aborted).toBe(false);
    expect(superseded.isCurrent).toBe(true);

    const current = scope.openRound();

    expect(superseded.signal.aborted).toBe(true);
    expect(superseded.isCurrent).toBe(false);
    expect(current.signal.aborted).toBe(false);
    expect(current.isCurrent).toBe(true);
  });

  it("refuses a superseded round's settlement and admits the current one's", () => {
    const scope = new ReadScope();
    const superseded = scope.openRound();
    const current = scope.openRound();
    const applied: string[] = [];

    expect(superseded.settle(() => applied.push("superseded"))).toBe(false);
    expect(current.settle(() => applied.push("current"))).toBe(true);

    expect(applied).toStrictEqual(["current"]);
  });

  it("abandons the open round and every later one", () => {
    const scope = new ReadScope();
    const openWhenAbandoned = scope.openRound();

    scope.abandon();

    expect(scope.isAbandoned).toBe(true);
    expect(openWhenAbandoned.signal.aborted).toBe(true);
    expect(openWhenAbandoned.isCurrent).toBe(false);

    const afterwards = scope.openRound();
    expect(afterwards.signal.aborted).toBe(true);
    expect(afterwards.isCurrent).toBe(false);
    expect(afterwards.settle(() => undefined)).toBe(false);
  });

  it("abandons a scope that never opened a round, and hands out a dead one", () => {
    const scope = new ReadScope();
    scope.abandon();
    expect(scope.openRound().signal.aborted).toBe(true);
  });

  it("is idempotent, because both the cleanup and the holder may reach it", () => {
    const scope = new ReadScope();
    const round = scope.openRound();
    scope.abandon();
    scope.abandon();
    expect(scope.isAbandoned).toBe(true);
    expect(round.signal.aborted).toBe(true);
  });
});

describe("settleUnlessAbandoned — the race that makes abandonment cost nothing", () => {
  it("settles with the value where nothing abandoned it", async () => {
    const scope = new ReadScope();
    const round = scope.openRound();

    const settlement = await settleUnlessAbandoned(Promise.resolve("read"), round.signal);

    expect(settlement).toStrictEqual({ status: "settled", value: "read" });
  });

  it("settles with the value where no signal was supplied at all", async () => {
    // The mutation shape: no owner who may leave, so the call is awaited exactly as
    // it was before this module existed.
    const settlement = await settleUnlessAbandoned(Promise.resolve(7), undefined);
    expect(settlement).toStrictEqual({ status: "settled", value: 7 });
  });

  it("answers abandoned without waiting for a read that never settles", async () => {
    const scope = new ReadScope();
    const round = scope.openRound();
    const held = heldPromise<string>();

    const settling = settleUnlessAbandoned(held.promise, round.signal);
    scope.abandon();

    // The held promise is still outstanding here, which is the whole claim: the
    // caller is released by the abandonment rather than by the read.
    await expect(settling).resolves.toStrictEqual({ status: "abandoned" });
  });

  it("answers abandoned immediately where the signal was already aborted", async () => {
    const scope = new ReadScope();
    scope.abandon();
    const held = heldPromise<string>();

    await expect(
      settleUnlessAbandoned(held.promise, scope.openRound().signal),
    ).resolves.toStrictEqual({ status: "abandoned" });
  });

  it("lets a rejection through where the read lost the race", async () => {
    const scope = new ReadScope();
    const round = scope.openRound();

    await expect(
      settleUnlessAbandoned(Promise.reject(new Error("wire")), round.signal),
    ).rejects.toThrow("wire");
  });

  it("swallows nothing and leaks nothing when the read rejects after abandonment", async () => {
    const scope = new ReadScope();
    const round = scope.openRound();
    const held = heldPromise<string>();

    const settling = settleUnlessAbandoned(held.promise, round.signal);
    scope.abandon();
    await expect(settling).resolves.toStrictEqual({ status: "abandoned" });

    // The late rejection is handled by the race rather than reaching the host as an
    // unhandled rejection. Awaiting it here proves it was a rejection at all; the
    // absence of an unhandled-rejection failure in this run is the other half.
    held.rejectWith(new Error("late"));
    await expect(held.promise).rejects.toThrow("late");
  });

  it("retires its abort listener on the ordinary path", async () => {
    const scope = new ReadScope();
    const round = scope.openRound();
    let listenerCount = 0;
    const { signal } = round;
    const originalAdd = signal.addEventListener.bind(signal);
    const originalRemove = signal.removeEventListener.bind(signal);
    // Counting through the signal's own methods rather than a stand-in, so the
    // assertion is about what the module really attached.
    Object.assign(signal, {
      addEventListener: (...listenerArguments: Parameters<typeof originalAdd>) => {
        listenerCount += 1;
        originalAdd(...listenerArguments);
      },
      removeEventListener: (...listenerArguments: Parameters<typeof originalRemove>) => {
        listenerCount -= 1;
        originalRemove(...listenerArguments);
      },
    });

    await settleUnlessAbandoned(Promise.resolve("read"), signal);

    expect(listenerCount).toBe(0);
  });
});
