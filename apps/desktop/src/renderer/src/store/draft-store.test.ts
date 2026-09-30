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

  it("negative control: a draft that survived carries no notice", () => {
    // Guards against a store that armed the notice on every key it had seen.
    const { store, typeInto } = storeHolding(2);
    typeInto("composer-a", "the oldest thing anybody typed");
    typeInto("composer-b", "something newer");
    typeInto("composer-c", "newer still");

    expect(store.evictionNoticePendingFor("composer-b")).toBe(false);
    expect(store.evictionNoticePendingFor("composer-c")).toBe(false);
  });

  it("negative control: text the user themselves cleared carries none either", () => {
    // A send and an eviction reach the subscriber through the same `undefined`, so arming on
    // every removal would put a loss notice beside a message the user just sent.
    const { store, typeInto } = storeHolding(2);
    typeInto("composer-a", "about to be sent");
    store.clear("composer-a");

    expect(store.evictionNoticePendingFor("composer-a")).toBe(false);
  });

  it("retires the notice when the user types there again", () => {
    const { store, typeInto } = storeHolding(1);
    typeInto("composer-a", "the oldest thing anybody typed");
    typeInto("composer-b", "newer");
    expect(store.evictionNoticePendingFor("composer-a")).toBe(true);

    typeInto("composer-a", "started over");

    expect(store.evictionNoticePendingFor("composer-a")).toBe(false);
  });

  it("retires it on acknowledgement", () => {
    const { store, typeInto } = storeHolding(1);
    typeInto("composer-a", "the oldest thing anybody typed");
    typeInto("composer-b", "newer");

    store.acknowledgeEvictionNotice("composer-a");

    expect(store.evictionNoticePendingFor("composer-a")).toBe(false);
  });

  it("bounds the armed notices by the same ceiling the drafts carry", () => {
    // An unbounded record of losses would be the leak the draft bound exists to prevent.
    const { store, typeInto } = storeHolding(1);
    typeInto("composer-a", "first");
    typeInto("composer-b", "second");
    typeInto("composer-c", "third");

    expect(store.evictionNoticePendingFor("composer-a")).toBe(false);
    expect(store.evictionNoticePendingFor("composer-b")).toBe(true);
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

describe("the draft store — a ceiling with no room in it is refused", () => {
  it("refuses a ceiling of zero rather than dropping every keystroke", () => {
    // Zero would evict every write's own entry, so no draft would ever stick.
    expect(() => new DraftStore({ maximumDraftCount: 0 })).toThrow(RangeError);
  });

  it("refuses a negative or fractional ceiling too", () => {
    expect(() => new DraftStore({ maximumDraftCount: -1 })).toThrow(RangeError);
    expect(() => new DraftStore({ maximumDraftCount: 1.5 })).toThrow(RangeError);
  });

  it("negative control: a ceiling of one is admitted and holds one draft", () => {
    // Guards against a constructor that refused every ceiling.
    const { store, typeInto } = storeHolding(1);
    typeInto("composer-a", "held");

    expect(store.read("composer-a")?.text).toBe("held");
    expect(store.liveDraftCount).toBe(1);
  });
});
