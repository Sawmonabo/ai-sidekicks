// The bounded arrival queue on its own: what it dedupes, what it defers, and when it
// says a replay is owed.
//
// Driven without a bridge, a feed, or a promise, which is the point of the split: the
// bound and the identity rule are decisions this class makes alone, and a suite that
// had to open a feed to reach them would be testing the adapter's plumbing beside
// them and calling it coverage of these.

import { describe, expect, it } from "vitest";

import { PENDING_INVITE_QUEUE_MAX } from "../../core/index.js";
import { PendingInviteArrivals } from "./pending-invite-arrivals.js";
import { readyPreview, refusedPreview, unavailablePreview } from "./pending-invite.test-support.js";

/** One ready arrival per reference, all distinct. */
function readyArrivals(count: number): readonly ReturnType<typeof readyPreview>[] {
  return Array.from({ length: count }, (_unused, index) =>
    readyPreview({ reference: `arrival-${String(index)}` }),
  );
}

describe("the pending arrival queue — what it holds once", () => {
  it("holds one copy of a reference, however many times it arrives", () => {
    const arrivals = new PendingInviteArrivals();
    expect(arrivals.admit(readyPreview())).toBe(true);
    expect(arrivals.admit(readyPreview())).toBe(false);
    expect(arrivals.waitingBehind).toBe(0);
  });

  it("holds one copy of an attempt handle, however many times it arrives", () => {
    const arrivals = new PendingInviteArrivals();
    expect(arrivals.admit(unavailablePreview())).toBe(true);
    expect(arrivals.admit(unavailablePreview())).toBe(false);
  });

  it("holds each refusal, because main mints no handle one could be matched on", () => {
    // Negative control for the two cases above: they would pass over a queue that
    // deduped everything by shape, which would silently merge two refusals of two
    // different deep links that happened to carry the same code.
    const arrivals = new PendingInviteArrivals();
    expect(arrivals.admit(refusedPreview())).toBe(true);
    expect(arrivals.admit(refusedPreview())).toBe(true);
    expect(arrivals.waitingBehind).toBe(1);
  });
});

describe("the pending arrival queue — the bound", () => {
  it("holds the bound and records that it turned one away", () => {
    const arrivals = new PendingInviteArrivals();
    for (const arrival of readyArrivals(PENDING_INVITE_QUEUE_MAX)) {
      arrivals.admit(arrival);
    }
    expect(arrivals.hasDeferredArrivals).toBe(false);

    expect(arrivals.admit(readyPreview({ reference: "one-too-many" }))).toBe(true);
    expect(arrivals.hasDeferredArrivals).toBe(true);
    expect(arrivals.waitingBehind).toBe(PENDING_INVITE_QUEUE_MAX - 1);
  });

  it("redraws once for a burst past the bound rather than once per frame", () => {
    const arrivals = new PendingInviteArrivals();
    for (const arrival of readyArrivals(PENDING_INVITE_QUEUE_MAX)) {
      arrivals.admit(arrival);
    }
    expect(arrivals.admit(readyPreview({ reference: "surplus-one" }))).toBe(true);
    expect(arrivals.admit(readyPreview({ reference: "surplus-two" }))).toBe(false);
  });

  it("owes exactly one replay per opening, and none while it is still full", () => {
    const arrivals = new PendingInviteArrivals();
    for (const arrival of readyArrivals(PENDING_INVITE_QUEUE_MAX)) {
      arrivals.admit(arrival);
    }
    arrivals.admit(readyPreview({ reference: "one-too-many" }));
    expect(arrivals.takeDeferredReplay()).toBe(false);

    arrivals.releaseHead();
    expect(arrivals.takeDeferredReplay()).toBe(true);
    expect(arrivals.takeDeferredReplay()).toBe(false);
  });

  it("negative control: a queue inside the bound owes no replay at all", () => {
    const arrivals = new PendingInviteArrivals();
    arrivals.admit(readyPreview());
    arrivals.releaseHead();
    expect(arrivals.takeDeferredReplay()).toBe(false);
  });
});

describe("the pending arrival queue — reading it", () => {
  it("answers for a reference only where a ready arm carries one", () => {
    const arrivals = new PendingInviteArrivals();
    arrivals.admit(refusedPreview());
    arrivals.admit(readyPreview({ reference: "held-reference" }));
    expect(arrivals.holdsReference("held-reference")).toBe(true);
    expect(arrivals.holdsReference("invite.expired")).toBe(false);
  });

  it("hands the head back so its owner can forget what it recorded", () => {
    const arrivals = new PendingInviteArrivals();
    arrivals.admit(readyPreview({ reference: "first" }));
    arrivals.admit(readyPreview({ reference: "second" }));
    expect(arrivals.releaseHead()).toMatchObject({ reference: "first" });
    expect(arrivals.head).toMatchObject({ reference: "second" });
  });

  it("forgets everything, debt included", () => {
    const arrivals = new PendingInviteArrivals();
    for (const arrival of readyArrivals(PENDING_INVITE_QUEUE_MAX + 1)) {
      arrivals.admit(arrival);
    }
    arrivals.clear();
    expect(arrivals.head).toBeUndefined();
    expect(arrivals.hasDeferredArrivals).toBe(false);
  });
});
