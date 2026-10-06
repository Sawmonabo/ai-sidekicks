// The read line's two endings, and the combinator that races them, driven against the real
// `ReadScope` and `settleUnlessAbandoned`. Each abort case is paired with the reading taken before
// it, since a scope that never aborted would pass a bare "signal is live" assertion.

import { describe, expect, it } from "vitest";

import { ReadScope, settleUnlessAbandoned } from "./scope.js";

/** A promise that never settles. */
function heldPromise<TValue>(): { readonly promise: Promise<TValue> } {
  return { promise: new Promise<TValue>(() => undefined) };
}

describe("ReadScope — one read line, two endings", () => {
  it("supersedes the previous round when a newer read opens, and refuses its settlement", () => {
    const scope = new ReadScope();
    const superseded = scope.openRound();
    // Control: before the second round exists the first is live on both readings, so the assertions
    // below are about the supersede and not a scope born aborted.
    expect(superseded.signal.aborted).toBe(false);
    expect(superseded.isCurrent).toBe(true);

    const current = scope.openRound();

    expect(superseded.signal.aborted).toBe(true);
    expect(superseded.isCurrent).toBe(false);
    expect(current.signal.aborted).toBe(false);
    expect(current.isCurrent).toBe(true);

    // Only the current round's settlement is applied.
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
});

describe("settleUnlessAbandoned — the race that makes abandonment cost nothing", () => {
  it("settles with the value where nothing abandoned it", async () => {
    const scope = new ReadScope();
    const round = scope.openRound();

    const settlement = await settleUnlessAbandoned(Promise.resolve("read"), round.signal);

    expect(settlement).toStrictEqual({ status: "settled", value: "read" });
  });

  it("answers abandoned without waiting for a read that never settles", async () => {
    const scope = new ReadScope();
    const round = scope.openRound();
    const held = heldPromise<string>();

    const settling = settleUnlessAbandoned(held.promise, round.signal);
    scope.abandon();

    // The held promise is still outstanding: the abandonment releases the caller, not the read.
    await expect(settling).resolves.toStrictEqual({ status: "abandoned" });
  });

  it("lets a rejection through where the read lost the race", async () => {
    const scope = new ReadScope();
    const round = scope.openRound();

    await expect(
      settleUnlessAbandoned(Promise.reject(new Error("wire")), round.signal),
    ).rejects.toThrow("wire");
  });
});
