// The holder's rule, with no renderer involved.
//
// Every rule this object carries — when a value is discarded, which publisher may
// write, what a late settlement does — is a property of the SUBJECT moving and not
// of a render happening, which is what makes it drivable with no React at all. The
// React half lives in `subject-scoped-state.test.tsx`, needs a tree, and asserts a
// different thing: which frames a re-address paints.
//
// A VISIT IS ADDRESSED AND CONFIRMED, because a render is not a commit. `visit(…)` is
// both calls in the order React makes them, and it is what every case about the
// surface ON SCREEN drives; the cases about a proposal that never reached the screen
// call `address` alone, which is exactly what an abandoned render leaves behind.
//
// Every clean assertion here is paired with a NEGATIVE CONTROL, because "the late
// settlement was dropped" is also satisfied by a publisher that never writes
// anything at all.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { consoleTripwires } from "../core/tripwires.js";
import { SUBJECT_ONE, SUBJECT_TWO } from "./subject-fixtures.test-support.js";
import { visit } from "./subject-scoped-drivers.test-support.js";
import { SubjectScopedHolder } from "./subject-scoped-holder.js";

// Tripwires throw in a development build, which would turn the two backstops below
// into the very escaping throws they exist to prevent. The recording arm is the one
// under test, exactly as it is for the surface error boundary next door.
let restoreThrowOnReport = false;

beforeEach(() => {
  restoreThrowOnReport = import.meta.env.DEV;
  consoleTripwires.setThrowOnReport(false);
  consoleTripwires.reset();
});

afterEach(() => {
  consoleTripwires.setThrowOnReport(restoreThrowOnReport);
  consoleTripwires.reset();
});

describe("SubjectScopedHolder — the rule, with no renderer involved", () => {
  it("seeds on the first address and keeps the value while the subject stands", () => {
    const holder = new SubjectScopedHolder<string>();
    let seedings = 0;
    const seed = (): string => {
      seedings += 1;
      return "seed";
    };
    visit(holder, SUBJECT_ONE, "alpha", seed);
    holder.publisherFor(SUBJECT_ONE, "alpha")("published");
    visit(holder, SUBJECT_ONE, "alpha", seed);
    expect(holder.value).toBe("published");
    expect(seedings).toBe(1);
  });

  it("discards the value the moment either half of the subject moves", () => {
    const holder = new SubjectScopedHolder<string>();
    visit(holder, SUBJECT_ONE, "alpha", () => "seed");
    holder.publisherFor(SUBJECT_ONE, "alpha")("published");
    visit(holder, SUBJECT_ONE, "beta", () => "seed");
    expect(holder.value).toBe("seed");
    holder.publisherFor(SUBJECT_ONE, "beta")("published again");
    visit(holder, SUBJECT_TWO, "beta", () => "seed");
    expect(holder.value).toBe("seed");
  });

  it("drops a publish captured under a subject that has since moved", () => {
    const holder = new SubjectScopedHolder<string>();
    visit(holder, SUBJECT_ONE, "alpha", () => "seed");
    const lateSettlement = holder.publisherFor(SUBJECT_ONE, "alpha");
    visit(holder, SUBJECT_TWO, "alpha", () => "seed");
    lateSettlement("the answer to a question nobody is asking");
    expect(holder.value).toBe("seed");
  });

  it("drops a settlement from a visit the subject left and came back to", () => {
    // A route round-trip: s1 -> s2 -> s1. The pair is equal on the first and third
    // visits, so a guard that compared only the pair admitted the FIRST visit's
    // reply into the third visit's state — the older read landing last and
    // overwriting the answer the surface on screen had already been given.
    const holder = new SubjectScopedHolder<string>();
    visit(holder, SUBJECT_ONE, "alpha", () => "seed");
    const settlementFromTheFirstVisit = holder.publisherFor(SUBJECT_ONE, "alpha");
    visit(holder, SUBJECT_TWO, "alpha", () => "seed");
    visit(holder, SUBJECT_ONE, "alpha", () => "seed");
    holder.publisherFor(SUBJECT_ONE, "alpha")("what the third visit read");
    settlementFromTheFirstVisit("what the first visit read");
    expect(holder.value).toBe("what the third visit read");
  });

  it("drops a capture from a visit the subject left and came back to", () => {
    // The same round-trip through the other capture moment, because `settle` reads
    // the live pair and would otherwise re-derive the same too-weak comparison.
    const holder = new SubjectScopedHolder<string>();
    visit(holder, SUBJECT_ONE, "alpha", () => "seed");
    const capturedOnTheFirstVisit = holder.settle();
    visit(holder, SUBJECT_TWO, "alpha", () => "seed");
    visit(holder, SUBJECT_ONE, "alpha", () => "seed");
    capturedOnTheFirstVisit("what the first visit read");
    expect(holder.value).toBe("seed");
  });

  it("negative control: a re-address to the pair already held admits its publisher", () => {
    // The addressing advances on a MOVE and not on a re-render, so the two cases
    // above are about a subject that actually left. A holder that minted a new
    // addressing per call would refuse this and pass both of them.
    const holder = new SubjectScopedHolder<string>();
    visit(holder, SUBJECT_ONE, "alpha", () => "seed");
    const publisher = holder.publisherFor(SUBJECT_ONE, "alpha");
    visit(holder, SUBJECT_ONE, "alpha", () => "a seed nothing asked for");
    publisher("landed");
    expect(holder.value).toBe("landed");
  });

  it("negative control: the same settlement lands while the subject stands", () => {
    // Without this, "dropped" above would also be satisfied by a publisher that
    // never writes anything at all.
    const holder = new SubjectScopedHolder<string>();
    visit(holder, SUBJECT_ONE, "alpha", () => "seed");
    const settlement = holder.publisherFor(SUBJECT_ONE, "alpha");
    settlement("landed");
    expect(holder.value).toBe("landed");
  });

  it("applies the function form against the value held now, not the one closed over", () => {
    const holder = new SubjectScopedHolder<readonly string[]>();
    visit(holder, SUBJECT_ONE, "alpha", () => []);
    const appendFirst = holder.publisherFor(SUBJECT_ONE, "alpha");
    const appendSecond = holder.publisherFor(SUBJECT_ONE, "alpha");
    appendFirst((previous) => [...previous, "first"]);
    appendSecond((previous) => [...previous, "second"]);
    expect(holder.value).toStrictEqual(["first", "second"]);
  });

  it("settle captures the subject standing when it is CALLED", () => {
    const holder = new SubjectScopedHolder<string>();
    visit(holder, SUBJECT_ONE, "alpha", () => "seed");
    const capturedEarly = holder.settle();
    visit(holder, SUBJECT_TWO, "alpha", () => "seed");
    const capturedLate = holder.settle();
    capturedEarly("from the subject that left");
    expect(holder.value).toBe("seed");
    capturedLate("from the subject on screen");
    expect(holder.value).toBe("from the subject on screen");
  });

  it("a capture taken before any address publishes nowhere rather than throwing", () => {
    const holder = new SubjectScopedHolder<string>();
    const beforeAnySubject = holder.settle();
    expect(() => {
      beforeAnySubject("nothing was ever addressed");
    }).not.toThrow();
    visit(holder, SUBJECT_ONE, "alpha", () => "seed");
    expect(holder.value).toBe("seed");
  });

  it("reading before an address is a composition error and says so", () => {
    const holder = new SubjectScopedHolder<string>();
    expect(() => holder.value).toThrow(/before it was addressed/);
  });

  it("wakes nobody for a publish that changes nothing", () => {
    const holder = new SubjectScopedHolder<string>();
    visit(holder, SUBJECT_ONE, "alpha", () => "seed");
    let wakes = 0;
    holder.subscribe(() => {
      wakes += 1;
    });
    holder.publisherFor(SUBJECT_ONE, "alpha")("seed");
    expect(wakes).toBe(0);
    // Negative control: the same subscription does wake for a real change.
    holder.publisherFor(SUBJECT_ONE, "alpha")("changed");
    expect(wakes).toBe(1);
  });
});

describe("SubjectScopedHolder — an addressing is a proposal until a render commits", () => {
  it("keeps the visit on screen publishable while a proposal stands", () => {
    // The defect this split closes: a pass that addressed a new subject and was then
    // thrown away used to retire the committed addressing as it was minted, which
    // left the tree on screen holding a publisher that refused every settlement and
    // reading a seed for a subject nothing had painted.
    const holder = new SubjectScopedHolder<string>();
    visit(holder, SUBJECT_ONE, "alpha", () => "seed");
    const settlementFromTheVisitOnScreen = holder.publisherFor(SUBJECT_ONE, "alpha");

    holder.address(SUBJECT_TWO, "alpha", () => "the seed a pass proposed");
    settlementFromTheVisitOnScreen("what the visit on screen read");

    // The pass reads its own proposal, which is the whole point of addressing during
    // a render; the visit on screen goes on holding what it was just given.
    expect(holder.value).toBe("the seed a pass proposed");
    holder.address(SUBJECT_ONE, "alpha", () => "a seed nothing asked for");
    expect(holder.value).toBe("what the visit on screen read");
  });

  it("negative control: the same publisher is refused once a proposal commits", () => {
    // Without this, "still publishable" above would also be satisfied by a holder
    // that never retired anything at all — which is the defect the addressing exists
    // to close, running in the other direction.
    const holder = new SubjectScopedHolder<string>();
    visit(holder, SUBJECT_ONE, "alpha", () => "seed");
    const settlementFromTheVisitThatEnded = holder.publisherFor(SUBJECT_ONE, "alpha");

    visit(holder, SUBJECT_TWO, "alpha", () => "the second visit's seed");
    settlementFromTheVisitThatEnded("the answer to a question nobody is asking");

    expect(holder.value).toBe("the second visit's seed");
  });

  it("refuses a settlement captured under a pass that never committed", () => {
    // The other half, and the one an A -> B -> A round-trip reaches: the abandoned
    // pass really ran and really handed its caller a publisher, and that publisher
    // names an addressing no frame ever carried.
    const holder = new SubjectScopedHolder<string>();
    visit(holder, SUBJECT_ONE, "alpha", () => "seed");
    holder.address(SUBJECT_TWO, "alpha", () => "the seed a pass proposed");
    const settlementFromThePassThatWasDropped = holder.publisherFor(SUBJECT_TWO, "alpha");

    holder.address(SUBJECT_ONE, "alpha", () => "a seed nothing asked for");
    settlementFromThePassThatWasDropped("what a pass nobody saw read");

    expect(holder.value).toBe("seed");
  });

  it("discards the value a proposal left behind, once and only once", () => {
    // For the caller whose value owns a connection, this is the whole difference
    // between a close and a leak: no commit reached the proposal, so no effect closed
    // over it, and the pass that supersedes it is its last reachable moment.
    const closed: string[] = [];
    const holder = new SubjectScopedHolder<string>({
      disposeUnheldValue: (unheld) => {
        closed.push(unheld);
      },
    });
    visit(holder, SUBJECT_ONE, "alpha", () => "the connection on screen");
    holder.address(SUBJECT_TWO, "alpha", () => "the connection a dropped pass opened");

    holder.address(SUBJECT_ONE, "alpha", () => "a connection nothing asked for");
    holder.discardProvisional();

    expect(closed).toStrictEqual(["the connection a dropped pass opened"]);
    // And the one on screen is untouched: it is what a live effect is holding, and
    // closing it here would tear down what the frame is reading through.
    expect(holder.value).toBe("the connection on screen");
  });

  it("commits nothing for a pair no proposal carries, and ends the proposal there is", () => {
    // A commit names the pair the render that committed was about. One naming a pair
    // no proposal carries confirms nothing — and says the pass that would have
    // committed the proposal is over, which is the same fact from the other side.
    const closed: string[] = [];
    const holder = new SubjectScopedHolder<string>({
      disposeUnheldValue: (unheld) => {
        closed.push(unheld);
      },
    });
    visit(holder, SUBJECT_ONE, "alpha", () => "the connection on screen");
    holder.address(SUBJECT_TWO, "alpha", () => "the connection a dropped pass opened");

    holder.commit(SUBJECT_ONE, "alpha");

    expect(closed).toStrictEqual(["the connection a dropped pass opened"]);
    expect(holder.value).toBe("the connection on screen");
  });

  it("settle names the visit on screen, never a proposal a pass left behind", () => {
    // `settle` is called from a handler, a ref, or an effect with no dependencies —
    // outside a render, where the only visit anything is reading through is the one
    // that committed.
    const holder = new SubjectScopedHolder<string>();
    visit(holder, SUBJECT_ONE, "alpha", () => "seed");
    holder.address(SUBJECT_TWO, "alpha", () => "the seed a pass proposed");

    holder.settle()("what the visit on screen read");

    holder.address(SUBJECT_ONE, "alpha", () => "a seed nothing asked for");
    expect(holder.value).toBe("what the visit on screen read");
  });
});
