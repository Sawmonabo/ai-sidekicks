// The bounded arrival queue on its own: what it dedupes, what it defers, and when it
// says a replay is owed.
//
// Driven without a bridge, a feed, or a promise, which is the point of the split: the
// bound and the identity rule are decisions this class makes alone, and a suite that
// had to open a feed to reach them would be testing the adapter's plumbing beside
// them and calling it coverage of these.

import { describe, expect, it } from "vitest";

import { PENDING_INVITE_QUEUE_MAX, PENDING_INVITE_RETAINED_REFUSAL_MAX } from "../../core/index.js";
import { PendingInviteArrivals } from "./pending-invite-arrivals.js";
import { readyPreview, refusedPreview, unavailablePreview } from "./pending-invite.test-support.js";

/** One ready arrival per reference, all distinct. */
function readyArrivals(count: number): readonly ReturnType<typeof readyPreview>[] {
  return Array.from({ length: count }, (_unused, index) =>
    readyPreview({ reference: `arrival-${String(index)}` }),
  );
}

/** A queue filled to its bound with invitations main would re-deliver. */
function arrivalsAtTheBound(): PendingInviteArrivals {
  const arrivals = new PendingInviteArrivals();
  for (const arrival of readyArrivals(PENDING_INVITE_QUEUE_MAX)) {
    arrivals.admit(arrival);
  }
  return arrivals;
}

/** Empty the queue one head at a time, so whatever was retained is promoted. */
function releaseTheWholeQueue(arrivals: PendingInviteArrivals): void {
  for (let released = 0; released < PENDING_INVITE_QUEUE_MAX; released += 1) {
    arrivals.releaseHead();
  }
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

describe("the pending arrival queue — a refusal that arrives past the bound", () => {
  it("retains it rather than owing a replay main will never perform", () => {
    // The defect: a refused preview mints no reference, so main holds nothing for it
    // and re-opening the feed brings nothing back. Recorded as replay debt and not
    // held, the expired, revoked, or already-accepted explanation was gone for the
    // life of the window.
    const arrivals = arrivalsAtTheBound();
    expect(arrivals.admit(refusedPreview({ code: "invite.revoked" }))).toBe(true);
    expect(arrivals.hasDeferredArrivals).toBe(false);
    expect(arrivals.waitingBehind).toBe(PENDING_INVITE_QUEUE_MAX);
  });

  it("hands it to the queue once releases have made room for it", () => {
    const arrivals = arrivalsAtTheBound();
    arrivals.admit(refusedPreview({ code: "invite.revoked" }));

    releaseTheWholeQueue(arrivals);

    expect(arrivals.head).toMatchObject({ status: "refused", code: "invite.revoked" });
    expect(arrivals.waitingBehind).toBe(0);
  });

  it("promotes them in arrival order, ahead of the invitations a replay would return", () => {
    const arrivals = arrivalsAtTheBound();
    arrivals.admit(refusedPreview({ detail: "first refusal" }));
    arrivals.admit(refusedPreview({ detail: "second refusal" }));

    releaseTheWholeQueue(arrivals);

    expect(arrivals.head).toMatchObject({ detail: "first refusal" });
    arrivals.releaseHead();
    expect(arrivals.head).toMatchObject({ detail: "second refusal" });
  });

  it("bounds what it retains, keeping the newest explanations", () => {
    // Bounded and never unbounded: the producer is the operating system, so a burst
    // has no ceiling of its own. Past the bound the OLDEST goes, because a register
    // that turned new arrivals away would let one burst blind the window for the
    // rest of the visit.
    const arrivals = arrivalsAtTheBound();
    for (let index = 0; index < PENDING_INVITE_RETAINED_REFUSAL_MAX + 1; index += 1) {
      arrivals.admit(refusedPreview({ detail: `refusal-${String(index)}` }));
    }
    expect(arrivals.waitingBehind).toBe(
      PENDING_INVITE_QUEUE_MAX - 1 + PENDING_INVITE_RETAINED_REFUSAL_MAX,
    );

    releaseTheWholeQueue(arrivals);

    expect(arrivals.head).toMatchObject({ detail: "refusal-1" });
  });

  it("negative control: an arrival main WOULD replay is still deferred, never retained", () => {
    // Without it, the cases above would pass over a queue that retained everything —
    // which would hold a second copy of every invitation the replay brings back and
    // stop asking for the replay that recovers the ones it did not.
    const arrivals = arrivalsAtTheBound();
    expect(arrivals.admit(readyPreview({ reference: "one-too-many" }))).toBe(true);
    expect(arrivals.admit(unavailablePreview())).toBe(false);
    expect(arrivals.hasDeferredArrivals).toBe(true);
    expect(arrivals.waitingBehind).toBe(PENDING_INVITE_QUEUE_MAX - 1);
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

  it("forgets everything — debt, and the refusals it was holding", () => {
    const arrivals = arrivalsAtTheBound();
    arrivals.admit(readyPreview({ reference: "one-too-many" }));
    arrivals.admit(refusedPreview({ detail: "retained across the release" }));

    arrivals.clear();

    expect(arrivals.head).toBeUndefined();
    expect(arrivals.hasDeferredArrivals).toBe(false);
    expect(arrivals.waitingBehind).toBe(0);
  });
});
