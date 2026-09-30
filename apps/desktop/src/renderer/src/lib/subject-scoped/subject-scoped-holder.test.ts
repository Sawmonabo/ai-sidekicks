// The holder's rule, with no renderer: when a value is discarded, which publisher may write, and
// what a late settlement does. Which frames a re-address paints is in
// `useSubjectScopedState.test.tsx`.
//
// A render is not a commit: `visit(...)` addresses and confirms, as React does, and drives the
// cases about the component on screen; cases about a proposal that never reached the screen call
// `address` alone. Each clean assertion has a negative control, since "the late settlement was
// dropped" is also satisfied by a publisher that never writes.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { windowTripwires } from "../tripwires.js";
import { SUBJECT_ONE, SUBJECT_TWO } from "@test/helpers/subject-fixtures.js";
import { visit } from "./subject-scoped-holder.test-support.js";
import { SubjectScopedHolder } from "./subject-scoped-holder.js";

// Tripwires throw in a development build, which would turn the backstops below into the escaping
// throws they exist to prevent; the recording arm is the one under test.
let restoreThrowOnReport = false;

beforeEach(() => {
  restoreThrowOnReport = import.meta.env.DEV;
  windowTripwires.setThrowOnReport(false);
  windowTripwires.reset();
});

afterEach(() => {
  windowTripwires.setThrowOnReport(restoreThrowOnReport);
  windowTripwires.reset();
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
    // A route round trip s1 -> s2 -> s1: the pair is equal on the first and third visits, so a
    // pair-only guard would admit the first visit's reply and overwrite the answer already given.
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
    // The same round trip through `settle`, which must not re-derive a pair-only comparison.
    const holder = new SubjectScopedHolder<string>();
    visit(holder, SUBJECT_ONE, "alpha", () => "seed");
    const capturedOnTheFirstVisit = holder.settle();
    visit(holder, SUBJECT_TWO, "alpha", () => "seed");
    visit(holder, SUBJECT_ONE, "alpha", () => "seed");
    capturedOnTheFirstVisit("what the first visit read");
    expect(holder.value).toBe("seed");
  });

  it("negative control: a re-address to the pair already held admits its publisher", () => {
    // The addressing advances on a move, not a re-render. A holder minting a new addressing per
    // call would refuse this and still pass the two cases above.
    const holder = new SubjectScopedHolder<string>();
    visit(holder, SUBJECT_ONE, "alpha", () => "seed");
    const publisher = holder.publisherFor(SUBJECT_ONE, "alpha");
    visit(holder, SUBJECT_ONE, "alpha", () => "a seed nothing asked for");
    publisher("landed");
    expect(holder.value).toBe("landed");
  });

  it("negative control: the same settlement lands while the subject stands", () => {
    // Without this, "dropped" above would also be satisfied by a publisher that never writes.
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
    // A thrown-away pass must not retire the committed addressing, or the tree on screen would
    // hold a publisher refusing every settlement and read a seed for a subject nothing painted.
    const holder = new SubjectScopedHolder<string>();
    visit(holder, SUBJECT_ONE, "alpha", () => "seed");
    const settlementFromTheVisitOnScreen = holder.publisherFor(SUBJECT_ONE, "alpha");

    holder.address(SUBJECT_TWO, "alpha", () => "the seed a pass proposed");
    settlementFromTheVisitOnScreen("what the visit on screen read");

    // The pass reads its own proposal; the visit on screen keeps what it was just given.
    expect(holder.value).toBe("the seed a pass proposed");
    holder.address(SUBJECT_ONE, "alpha", () => "a seed nothing asked for");
    expect(holder.value).toBe("what the visit on screen read");
  });

  it("negative control: the same publisher is refused once a proposal commits", () => {
    // Without this, "still publishable" above would pass for a holder that never retires anything.
    const holder = new SubjectScopedHolder<string>();
    visit(holder, SUBJECT_ONE, "alpha", () => "seed");
    const settlementFromTheVisitThatEnded = holder.publisherFor(SUBJECT_ONE, "alpha");

    visit(holder, SUBJECT_TWO, "alpha", () => "the second visit's seed");
    settlementFromTheVisitThatEnded("the answer to a question nobody is asking");

    expect(holder.value).toBe("the second visit's seed");
  });

  it("refuses a settlement captured under a pass that never committed", () => {
    // An A -> B -> A round trip reaches this: the abandoned pass handed out a publisher naming an
    // addressing no frame carried.
    const holder = new SubjectScopedHolder<string>();
    visit(holder, SUBJECT_ONE, "alpha", () => "seed");
    holder.address(SUBJECT_TWO, "alpha", () => "the seed a pass proposed");
    const settlementFromThePassThatWasDropped = holder.publisherFor(SUBJECT_TWO, "alpha");

    holder.address(SUBJECT_ONE, "alpha", () => "a seed nothing asked for");
    settlementFromThePassThatWasDropped("what a pass nobody saw read");

    expect(holder.value).toBe("seed");
  });

  it("discards the value a proposal left behind, once and only once", () => {
    // For a value that owns a connection this is the difference between a close and a leak: no
    // commit reached the proposal, so the superseding pass is its last reachable moment.
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
    // The one on screen is untouched: a live effect holds it.
    expect(holder.value).toBe("the connection on screen");
  });

  it("commits nothing for a pair no proposal carries, and ends the proposal there is", () => {
    // A commit naming a pair no proposal carries confirms nothing and ends the proposal.
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
    // `settle` runs outside a render, where only the committed visit is being read.
    const holder = new SubjectScopedHolder<string>();
    visit(holder, SUBJECT_ONE, "alpha", () => "seed");
    holder.address(SUBJECT_TWO, "alpha", () => "the seed a pass proposed");

    holder.settle()("what the visit on screen read");

    holder.address(SUBJECT_ONE, "alpha", () => "a seed nothing asked for");
    expect(holder.value).toBe("what the visit on screen read");
  });
});
