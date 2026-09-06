// The draft store: what a bounded window does with text nobody sent, and what it
// tells the person whose text it dropped.
//
// The property worth the most here is the disclosure, because its failure is
// silent. The module's own header states the rule the whole class exists for — a
// draft is never lost without the participant being told — and the live ceiling
// reached around it: past the bound the least-recently-typed draft was deleted and
// its composer notified with `undefined`, which is byte-for-byte what a send looks
// like. Cleared, sent, and evicted arrived through one signal and only one of them
// is a loss nobody asked for.

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
    restartNoticePending: false,
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
    // Without this, the case above would hold for a store that armed the notice on
    // every key it had ever seen — which would tell a person their text was lost
    // while it sat on screen in front of them.
    const { store, typeInto } = storeHolding(2);
    typeInto("composer-a", "the oldest thing anybody typed");
    typeInto("composer-b", "something newer");
    typeInto("composer-c", "newer still");

    expect(store.evictionNoticePendingFor("composer-b")).toBe(false);
    expect(store.evictionNoticePendingFor("composer-c")).toBe(false);
  });

  it("negative control: text the participant themselves cleared carries none either", () => {
    // A send and an eviction reach the subscriber through the same `undefined`, so a
    // store that armed on every removal would put a loss notice beside a message the
    // participant had just sent.
    const { store, typeInto } = storeHolding(2);
    typeInto("composer-a", "about to be sent");
    store.clear("composer-a");

    expect(store.evictionNoticePendingFor("composer-a")).toBe(false);
  });

  it("retires the notice when the participant types there again", () => {
    const { store, typeInto } = storeHolding(1);
    typeInto("composer-a", "the oldest thing anybody typed");
    typeInto("composer-b", "newer");
    expect(store.evictionNoticePendingFor("composer-a")).toBe(true);

    typeInto("composer-a", "started over");

    expect(store.evictionNoticePendingFor("composer-a")).toBe(false);
  });

  it("retires it on acknowledgement, the way the restart notice is retired", () => {
    const { store, typeInto } = storeHolding(1);
    typeInto("composer-a", "the oldest thing anybody typed");
    typeInto("composer-b", "newer");

    store.acknowledgeEvictionNotice("composer-a");

    expect(store.evictionNoticePendingFor("composer-a")).toBe(false);
  });

  it("bounds the armed notices by the same ceiling the drafts carry", () => {
    // A record of losses that grew without limit would be the leak the draft bound
    // exists to prevent, kept in a second map.
    const { store, typeInto } = storeHolding(1);
    typeInto("composer-a", "first");
    typeInto("composer-b", "second");
    typeInto("composer-c", "third");

    expect(store.evictionNoticePendingFor("composer-a")).toBe(false);
    expect(store.evictionNoticePendingFor("composer-b")).toBe(true);
  });

  it("still tells the subscriber its draft went", () => {
    // The notice is beside the signal, never instead of it: a composer that stopped
    // being told its text was gone would render text the store no longer holds.
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
    // Zero makes every write evict its own entry and notify `undefined`, so no draft
    // ever sticks: a store that silently holds nothing, which is the opposite of the
    // one thing this class is for. Unreachable from the frame today, and the option
    // is public.
    expect(() => new DraftStore({ maximumDraftCount: 0 })).toThrow(RangeError);
  });

  it("refuses a negative or fractional ceiling too", () => {
    expect(() => new DraftStore({ maximumDraftCount: -1 })).toThrow(RangeError);
    expect(() => new DraftStore({ maximumDraftCount: 1.5 })).toThrow(RangeError);
  });

  it("negative control: a ceiling of one is admitted and holds one draft", () => {
    // Without this, the cases above would hold for a constructor that refused every
    // ceiling there is.
    const { store, typeInto } = storeHolding(1);
    typeInto("composer-a", "held");

    expect(store.read("composer-a")?.text).toBe("held");
    expect(store.liveDraftCount).toBe(1);
  });
});
