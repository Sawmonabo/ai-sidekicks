// The draft store: what a bounded window does with text nobody sent.

import { describe, expect, it } from "vitest";

import { DraftStore } from "./draft-store.js";

/** A store on a clock the case owns, so eviction order is a fact and not a race. */
function storeHolding(maximumDraftCount: number): {
  readonly store: DraftStore;
  readonly typeInto: (draftKey: string, text: string) => void;
} {
  let tick = 0;
  const store = new DraftStore({
    maximumDraftCount,
    now: () => {
      tick += 1;
      return tick;
    },
  });
  return { store, typeInto: (draftKey, text) => store.write(draftKey, text) };
}

describe("the draft store — a ceiling that drops text", () => {
  it("tells the subscriber its draft went", () => {
    // Otherwise a composer would keep rendering text the store no longer holds.
    const { store, typeInto } = storeHolding(1);
    const seen: (string | undefined)[] = [];
    store.subscribe("composer-a", (draft) => seen.push(draft?.text));
    typeInto("composer-a", "the oldest thing anybody typed");
    typeInto("composer-b", "newer");

    expect(seen).toStrictEqual(["the oldest thing anybody typed", undefined]);
  });
});
