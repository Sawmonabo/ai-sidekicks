// The three properties every snapshot rebuild depends on, none of which the three
// hand-written copies this module replaced had ever asserted.
//
// The key leaves and its siblings do not; the ORIGINAL record is untouched, which is what
// makes the returned one safe to hand a `useSyncExternalStore` reader; and the identity
// rules are two halves of one claim — a removal that happened returns a NEW object so the
// surface repaints, and one that did not returns the SAME object so it does not. The last
// case is the negative control: an inherited key is not a member, so asking for one must
// take the same-identity path rather than rebuilding to change nothing.

import { describe, expect, it } from "vitest";

import { withoutKey } from "./keyed-record.js";

describe("withoutKey", () => {
  it("drops the named key and keeps every other member", () => {
    expect(withoutKey({ left: 1, middle: 2, right: 3 }, "middle")).toStrictEqual({
      left: 1,
      right: 3,
    });
  });

  it("leaves the record it was given untouched", () => {
    const entries = { left: 1, right: 2 };
    withoutKey(entries, "left");
    expect(entries).toStrictEqual({ left: 1, right: 2 });
  });

  it("returns a new object when the key was held, so a snapshot reader repaints", () => {
    const entries = { held: "refusal" };
    expect(withoutKey(entries, "held")).not.toBe(entries);
  });

  it("returns the same object when the key was never held, so nothing repaints", () => {
    const entries = { held: "refusal" };
    expect(withoutKey(entries, "absent")).toBe(entries);
  });

  it("treats an inherited key as absent rather than as a member to remove", () => {
    // `toString` resolves through the prototype chain, so a `key in entries` test would
    // report it present and rebuild — a new snapshot identity for a member the record
    // does not hold.
    const entries = { held: "refusal" };
    expect(withoutKey(entries, "toString")).toBe(entries);
  });
});
