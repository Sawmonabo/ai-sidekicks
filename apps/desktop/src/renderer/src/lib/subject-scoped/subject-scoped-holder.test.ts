// The holder's rule, with no renderer: when a value is discarded, which publisher may write, and
// what a late settlement does. Which frames a re-address paints is in
// `useSubjectScopedState.test.tsx`.
//
// A render is not a commit: `visit(...)` addresses and confirms, as React does, and drives the
// cases about the component on screen; cases about a proposal that never reached the screen call
// `address` alone. Each clean assertion has a negative control, since "the late settlement was
// dropped" is also satisfied by a publisher that never writes. What becomes of a value the holder
// let go of is at the end.

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

  it("admits the publisher of a re-address to the pair already held", () => {
    // The addressing advances on a move, not a re-render. A holder minting a new addressing per
    // call would refuse this and still pass the two cases above.
    const holder = new SubjectScopedHolder<string>();
    visit(holder, SUBJECT_ONE, "alpha", () => "seed");
    const publisher = holder.publisherFor(SUBJECT_ONE, "alpha");
    visit(holder, SUBJECT_ONE, "alpha", () => "a seed nothing asked for");
    publisher("landed");
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
});

describe("SubjectScopedHolder — a disposal that throws does not take the render with it", () => {
  /** The value a pass proposed, which the case that supersedes it cannot dispose. */
  const UNDISPOSABLE = "the value that owns a registry";

  it("leaves the proposal that superseded it addressed and publishable, and records why", () => {
    // This runs inside a render body. Escaping, the throw would reach the region's error boundary
    // and unmount the subtree, leaving the newest proposal held by nothing.
    const holder = new SubjectScopedHolder<string>({
      disposeUnheldValue: (unheld) => {
        if (unheld === UNDISPOSABLE) {
          throw new Error("the registry this value owned refused to dispose");
        }
      },
    });
    visit(holder, SUBJECT_ONE, "alpha", () => "the visit on screen");
    holder.address(SUBJECT_TWO, "alpha", () => UNDISPOSABLE);

    expect(() => {
      holder.address(SUBJECT_TWO, "beta", () => "the proposal that superseded it");
    }).not.toThrow();

    expect(holder.value).toBe("the proposal that superseded it");
    expect(windowTripwires.firingCount("region-render-failure")).toBe(1);
    expect(windowTripwires.reports().at(-1)?.detail).toContain("refused to dispose");
    // The superseding pass can still settle into what it addressed.
    holder.publisherFor(SUBJECT_TWO, "beta")("what the new pass read");
    expect(holder.value).toBe("what the new pass read");
    expect(windowTripwires.firingCount("unheld-resource")).toBe(0);
  });
});

describe("SubjectScopedHolder — a resource it refuses is disposed rather than dropped", () => {
  /** What the caller's disposal was handed, in order, so a double close is visible. */
  function holderDisposing(closed: string[]): SubjectScopedHolder<string> {
    return new SubjectScopedHolder<string>({
      disposeUnheldValue: (unheld) => {
        closed.push(unheld);
      },
    });
  }

  it("closes a resource that settled into a visit which had already ended", () => {
    // An async open: the component was re-addressed while it was in flight, so the settlement
    // names a visit nothing is addressed at and this disposal is the only path to the resource.
    const closed: string[] = [];
    const holder = holderDisposing(closed);
    visit(holder, SUBJECT_ONE, "alpha", () => "the connection the first visit opened");
    const settlementFromTheVisitThatEnded = holder.publisherFor(SUBJECT_ONE, "alpha");
    visit(holder, SUBJECT_TWO, "alpha", () => "the connection the second visit opened");

    settlementFromTheVisitThatEnded("the connection that opened too late");

    expect(closed).toStrictEqual(["the connection that opened too late"]);
    expect(holder.value).toBe("the connection the second visit opened");
    expect(windowTripwires.firingCount("unheld-resource")).toBe(1);
    expect(windowTripwires.reports().at(-1)?.detail).toContain("had already ended");
  });

  it("hands a resource a later publish replaced to the same disposal", () => {
    // Two publishes in one batched event: the first is replaced with no commit between, so no
    // effect closed over it; the holder's own write is the last moment it is reachable.
    const closed: string[] = [];
    const holder = holderDisposing(closed);
    visit(holder, SUBJECT_ONE, "alpha", () => "the connection the visit opened");
    const publish = holder.publisherFor(SUBJECT_ONE, "alpha");

    publish("the connection published second");
    publish("the connection published third");

    expect(closed).toStrictEqual([
      "the connection the visit opened",
      "the connection published second",
    ]);
    expect(holder.value).toBe("the connection published third");
    // Ordinary, so nothing is reported: a window replaces a store that closed itself this way.
    expect(windowTripwires.totalFiringCount).toBe(0);
  });

  it("disposes nothing for a publish that changes nothing", () => {
    // The value is still held, so disposing it would close what the component reads through.
    const closed: string[] = [];
    const holder = holderDisposing(closed);
    visit(holder, SUBJECT_ONE, "alpha", () => "the only connection");

    holder.publisherFor(SUBJECT_ONE, "alpha")("the only connection");

    expect(closed).toStrictEqual([]);
    expect(holder.value).toBe("the only connection");
  });
});
