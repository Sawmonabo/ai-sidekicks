// The draft store: what a bounded window does with text nobody sent, and what it tells the
// person whose text it dropped. The disclosure matters most because its failure is silent:
// cleared, sent and evicted reach a composer through the same `undefined` signal, and only
// eviction is a loss nobody asked for.

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

describe("the draft store — a ceiling that drops text says so", () => {
  it("arms a notice on the composer whose draft the ceiling dropped", () => {
    const { store, typeInto } = storeHolding(2);
    typeInto("composer-a", "the oldest thing anybody typed");
    typeInto("composer-b", "something newer");
    typeInto("composer-c", "newer still");

    expect(store.read("composer-a")).toBeUndefined();
    expect(store.evictionNoticePendingFor("composer-a")).toBe(true);
    expect(store.evictionNoticeText).toContain("dropped");
  });

  it("still tells the subscriber its draft went", () => {
    // The notice is beside the signal, never instead of it; otherwise a composer would keep
    // rendering text the store no longer holds.
    const { store, typeInto } = storeHolding(1);
    const seen: (string | undefined)[] = [];
    store.subscribe("composer-a", (draft) => seen.push(draft?.text));
    typeInto("composer-a", "the oldest thing anybody typed");
    typeInto("composer-b", "newer");

    expect(seen).toStrictEqual(["the oldest thing anybody typed", undefined]);
  });
});
