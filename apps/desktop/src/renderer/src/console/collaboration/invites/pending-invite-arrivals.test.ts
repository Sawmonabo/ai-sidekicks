// The bounded arrival queue on its own: what it dedupes, what it defers, and when it
// says a replay is owed.
//
// Driven without a bridge, a feed, or a promise, which is the point of the split: the
// bound and the identity rule are decisions this class makes alone, and a suite that
// had to open a feed to reach them would be testing the adapter's plumbing beside
// them and calling it coverage of these.

import { describe, expect, it } from "vitest";

import type { GrowthPendingInviteState } from "../../bridge/index.js";
import {
  PENDING_INVITE_DEFERRED_PLACE_MAX,
  PENDING_INVITE_QUEUE_MAX,
  PENDING_INVITE_RETAINED_REFUSAL_MAX,
} from "../../core/index.js";
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

/** How a case names one arrival, whichever arm it arrived on. */
function labelOf(arrival: GrowthPendingInviteState): string {
  switch (arrival.status) {
    case "ready":
      return arrival.reference;
    case "refused":
      return arrival.detail;
    case "unavailable":
      return arrival.attempt;
  }
}

/**
 * Meet every prompt in turn, letting main re-deliver what it is still holding.
 *
 * The owner's loop in miniature, and the replay has to be in it: a release opens a
 * slot, a release that owes a replay re-opens the feed, and the frames that come back
 * are the ones the bound turned away — the queued ones dedupe. Draining without that
 * step would assert the order of what the queue happened to be holding rather than
 * the order a person actually meets prompts in.
 */
function drainWithReplay(
  arrivals: PendingInviteArrivals,
  mainStillHolds: readonly ReturnType<typeof readyPreview>[],
): readonly string[] {
  let outstanding = [...mainStillHolds];
  const met: string[] = [];
  for (let step = 0; step < DRAIN_STEP_MAX; step += 1) {
    const head = arrivals.head;
    if (head === undefined) {
      return met;
    }
    met.push(labelOf(head));
    arrivals.releaseHead();
    if (arrivals.takeDeferredReplay()) {
      for (const frame of outstanding) {
        arrivals.admit(frame);
      }
      outstanding = outstanding.filter((frame) => !arrivals.holdsReference(frame.reference));
    }
  }
  throw new Error("the queue never emptied");
}

/** Enough turns to empty any queue a case here builds, and a failure if it does not. */
const DRAIN_STEP_MAX = 64;

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

  it("promotes them in the order they arrived in", () => {
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

  it("keeps one order across both registers, so a burst of them starves nothing", () => {
    // THE DEFECT. The retained refusal took every freed slot on sight, so a queue
    // that had just turned an INVITATION away filled straight back up with the
    // refusal that arrived after it — and the replay that would have brought the
    // invitation back was declined for want of room, once per refusal, until the
    // whole burst had been dealt with. The feed came out backwards and the arrivals a
    // person can actually act on waited longest.
    const arrivals = arrivalsAtTheBound();
    const deferred = readyPreview({ reference: "deferred-invitation" });
    arrivals.admit(deferred);
    arrivals.admit(refusedPreview({ detail: "first refusal" }));
    arrivals.admit(refusedPreview({ detail: "second refusal" }));

    const met = drainWithReplay(arrivals, [deferred]);

    expect(met.slice(PENDING_INVITE_QUEUE_MAX)).toEqual([
      "deferred-invitation",
      "first refusal",
      "second refusal",
    ]);
  });

  it("leaves the freed slot open where the replay is owed something older", () => {
    // The mechanism the case above rests on: promoting nothing is what leaves the
    // room a replay needs, and a register that always promoted would find the queue
    // full at exactly this moment.
    const arrivals = arrivalsAtTheBound();
    arrivals.admit(readyPreview({ reference: "deferred-invitation" }));
    arrivals.admit(refusedPreview({ detail: "later refusal" }));

    arrivals.releaseHead();

    expect(arrivals.takeDeferredReplay()).toBe(true);
  });

  it("negative control: a refusal that arrived FIRST still takes the slot", () => {
    // Without this the pair above would pass over a register that simply never
    // promoted while any debt was outstanding — which would hold every refusal behind
    // a replay that has no claim on the slot, the same starvation the other way round.
    const arrivals = arrivalsAtTheBound();
    arrivals.admit(refusedPreview({ detail: "earlier refusal" }));
    arrivals.admit(readyPreview({ reference: "deferred-invitation" }));

    arrivals.releaseHead();

    expect(arrivals.takeDeferredReplay()).toBe(false);
    expect(arrivals.hasDeferredArrivals).toBe(true);
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

describe("the pending arrival queue — the place every deferred arrival keeps", () => {
  /** Two invitations past the bound, then a refusal behind both of them. */
  function twoDeferredThenARefusal(): {
    readonly arrivals: PendingInviteArrivals;
    readonly deferred: readonly ReturnType<typeof readyPreview>[];
  } {
    const arrivals = arrivalsAtTheBound();
    const deferred = [
      readyPreview({ reference: "deferred-first" }),
      readyPreview({ reference: "deferred-second" }),
    ];
    for (const arrival of deferred) {
      arrivals.admit(arrival);
    }
    arrivals.admit(refusedPreview({ detail: "refusal behind both" }));
    return { arrivals, deferred };
  }

  it("promotes the refusal only after both invitations that arrived before it", () => {
    // THE DEFECT. One deferred sequence was remembered for the whole debt, so the
    // replay that recovered the FIRST invitation left the second to be stamped afresh
    // — after the refusal — and the next release handed the slot to a refusal younger
    // than the invitation it jumped. The starvation the ordering rule exists to stop,
    // one arrival further in than the rule reached.
    const { arrivals, deferred } = twoDeferredThenARefusal();

    const met = drainWithReplay(arrivals, deferred);

    expect(met.slice(PENDING_INVITE_QUEUE_MAX)).toEqual([
      "deferred-first",
      "deferred-second",
      "refusal behind both",
    ]);
  });

  it("keeps both places whichever order the replay hands them back in", () => {
    // Which frame a re-opened feed delivers first is main's business, and the
    // refusal's place does not depend on it: it arrived after both, so it waits for
    // both either way.
    const { arrivals, deferred } = twoDeferredThenARefusal();

    const met = drainWithReplay(arrivals, [...deferred].reverse());

    expect(met.slice(PENDING_INVITE_QUEUE_MAX)).toEqual([
      "deferred-second",
      "deferred-first",
      "refusal behind both",
    ]);
  });

  it("keeps no place past its own bound, and still owes the replay that recovers it", () => {
    // The register is memory a quiet feed never drains, so it is bounded — and the
    // half a bound must not take is the recovery. The over-bound arrival is still
    // deferred and still comes back; what it gives up is only its PRIORITY, so it
    // re-enters after the refusal it actually preceded rather than before it. Keeping
    // its place and dropping an older one instead would surrender exactly the claim
    // the order exists to protect.
    const arrivals = arrivalsAtTheBound();
    const placed = Array.from({ length: PENDING_INVITE_DEFERRED_PLACE_MAX }, (_unused, index) =>
      readyPreview({ reference: `placed-${String(index)}` }),
    );
    for (const arrival of placed) {
      arrivals.admit(arrival);
    }
    const overflow = readyPreview({ reference: "kept-no-place" });
    arrivals.admit(overflow);
    arrivals.admit(refusedPreview({ detail: "refusal after the register filled" }));
    expect(arrivals.hasDeferredArrivals).toBe(true);

    const met = drainWithReplay(arrivals, [...placed, overflow]);

    expect(met.slice(PENDING_INVITE_QUEUE_MAX + PENDING_INVITE_DEFERRED_PLACE_MAX)).toEqual([
      "refusal after the register filled",
      "kept-no-place",
    ]);
  });

  it("negative control: a place is spent once its arrival is back in the queue", () => {
    // Without it the cases above would pass over a register that kept a place after
    // the replay had used it — which would go on holding freed slots open against a
    // refusal that is now the oldest thing waiting, for an invitation a person is
    // already looking at.
    const arrivals = arrivalsAtTheBound();
    const deferred = readyPreview({ reference: "deferred-once" });
    arrivals.admit(deferred);
    arrivals.admit(refusedPreview({ detail: "refusal behind it" }));
    const later = readyPreview({ reference: "later arrival" });
    arrivals.admit(later);

    const met = drainWithReplay(arrivals, [deferred, later]);

    expect(met.slice(PENDING_INVITE_QUEUE_MAX)).toEqual([
      "deferred-once",
      "refusal behind it",
      "later arrival",
    ]);
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
