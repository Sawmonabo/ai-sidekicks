// The holder's rule, with no renderer involved.
//
// Every rule this object carries — when a value is discarded, which publisher may
// write, what a late settlement does — is a property of the SUBJECT moving and not
// of a render happening, which is what makes it drivable with no React at all. The
// React half lives in `subject-scoped-state.test.tsx`, needs a tree, and asserts a
// different thing: which frames a re-address paints.
//
// Every clean assertion here is paired with a NEGATIVE CONTROL, because "the late
// settlement was dropped" is also satisfied by a publisher that never writes
// anything at all.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { consoleTripwires } from "../core/tripwires.js";
import { SUBJECT_ONE, SUBJECT_TWO } from "./subject-fixtures.test-support.js";
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
    holder.address(SUBJECT_ONE, "alpha", seed);
    holder.publisherFor(SUBJECT_ONE, "alpha")("published");
    holder.address(SUBJECT_ONE, "alpha", seed);
    expect(holder.value).toBe("published");
    expect(seedings).toBe(1);
  });

  it("discards the value the moment either half of the subject moves", () => {
    const holder = new SubjectScopedHolder<string>();
    holder.address(SUBJECT_ONE, "alpha", () => "seed");
    holder.publisherFor(SUBJECT_ONE, "alpha")("published");
    holder.address(SUBJECT_ONE, "beta", () => "seed");
    expect(holder.value).toBe("seed");
    holder.publisherFor(SUBJECT_ONE, "beta")("published again");
    holder.address(SUBJECT_TWO, "beta", () => "seed");
    expect(holder.value).toBe("seed");
  });

  it("drops a publish captured under a subject that has since moved", () => {
    const holder = new SubjectScopedHolder<string>();
    holder.address(SUBJECT_ONE, "alpha", () => "seed");
    const lateSettlement = holder.publisherFor(SUBJECT_ONE, "alpha");
    holder.address(SUBJECT_TWO, "alpha", () => "seed");
    lateSettlement("the answer to a question nobody is asking");
    expect(holder.value).toBe("seed");
  });

  it("drops a settlement from a visit the subject left and came back to", () => {
    // A route round-trip: s1 -> s2 -> s1. The pair is equal on the first and third
    // visits, so a guard that compared only the pair admitted the FIRST visit's
    // reply into the third visit's state — the older read landing last and
    // overwriting the answer the surface on screen had already been given.
    const holder = new SubjectScopedHolder<string>();
    holder.address(SUBJECT_ONE, "alpha", () => "seed");
    const settlementFromTheFirstVisit = holder.publisherFor(SUBJECT_ONE, "alpha");
    holder.address(SUBJECT_TWO, "alpha", () => "seed");
    holder.address(SUBJECT_ONE, "alpha", () => "seed");
    holder.publisherFor(SUBJECT_ONE, "alpha")("what the third visit read");
    settlementFromTheFirstVisit("what the first visit read");
    expect(holder.value).toBe("what the third visit read");
  });

  it("drops a capture from a visit the subject left and came back to", () => {
    // The same round-trip through the other capture moment, because `settle` reads
    // the live pair and would otherwise re-derive the same too-weak comparison.
    const holder = new SubjectScopedHolder<string>();
    holder.address(SUBJECT_ONE, "alpha", () => "seed");
    const capturedOnTheFirstVisit = holder.settle();
    holder.address(SUBJECT_TWO, "alpha", () => "seed");
    holder.address(SUBJECT_ONE, "alpha", () => "seed");
    capturedOnTheFirstVisit("what the first visit read");
    expect(holder.value).toBe("seed");
  });

  it("negative control: a re-address to the pair already held admits its publisher", () => {
    // The addressing advances on a MOVE and not on a re-render, so the two cases
    // above are about a subject that actually left. A holder that minted a new
    // addressing per call would refuse this and pass both of them.
    const holder = new SubjectScopedHolder<string>();
    holder.address(SUBJECT_ONE, "alpha", () => "seed");
    const publisher = holder.publisherFor(SUBJECT_ONE, "alpha");
    holder.address(SUBJECT_ONE, "alpha", () => "a seed nothing asked for");
    publisher("landed");
    expect(holder.value).toBe("landed");
  });

  it("negative control: the same settlement lands while the subject stands", () => {
    // Without this, "dropped" above would also be satisfied by a publisher that
    // never writes anything at all.
    const holder = new SubjectScopedHolder<string>();
    holder.address(SUBJECT_ONE, "alpha", () => "seed");
    const settlement = holder.publisherFor(SUBJECT_ONE, "alpha");
    settlement("landed");
    expect(holder.value).toBe("landed");
  });

  it("applies the function form against the value held now, not the one closed over", () => {
    const holder = new SubjectScopedHolder<readonly string[]>();
    holder.address(SUBJECT_ONE, "alpha", () => []);
    const appendFirst = holder.publisherFor(SUBJECT_ONE, "alpha");
    const appendSecond = holder.publisherFor(SUBJECT_ONE, "alpha");
    appendFirst((previous) => [...previous, "first"]);
    appendSecond((previous) => [...previous, "second"]);
    expect(holder.value).toStrictEqual(["first", "second"]);
  });

  it("settle captures the subject standing when it is CALLED", () => {
    const holder = new SubjectScopedHolder<string>();
    holder.address(SUBJECT_ONE, "alpha", () => "seed");
    const capturedEarly = holder.settle();
    holder.address(SUBJECT_TWO, "alpha", () => "seed");
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
    holder.address(SUBJECT_ONE, "alpha", () => "seed");
    expect(holder.value).toBe("seed");
  });

  it("reading before an address is a composition error and says so", () => {
    const holder = new SubjectScopedHolder<string>();
    expect(() => holder.value).toThrow(/before it was addressed/);
  });

  it("wakes nobody for a publish that changes nothing", () => {
    const holder = new SubjectScopedHolder<string>();
    holder.address(SUBJECT_ONE, "alpha", () => "seed");
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

describe("SubjectScopedHolder — a disposal that throws does not take the replacement", () => {
  it("leaves the replacement addressed and publishable, and records the reason", () => {
    // Escaping, this throw leaves the render with the NEW value installed and no
    // commit ever reaching it — so the resource the disposal was clearing room for is
    // held by nothing. That is the one path in this module a throw could take.
    const holder = new SubjectScopedHolder<string>();
    holder.address(SUBJECT_ONE, "alpha", () => "the value that owns a registry");

    expect(() => {
      holder.address(
        SUBJECT_TWO,
        "alpha",
        () => "the replacement",
        () => {
          throw new Error("the registry this value owned refused to dispose");
        },
      );
    }).not.toThrow();

    expect(holder.value).toBe("the replacement");
    holder.publisherFor(SUBJECT_TWO, "alpha")("what the new subject read");
    expect(holder.value).toBe("what the new subject read");
    expect(consoleTripwires.firingCount("surface-render-failure")).toBe(1);
    expect(consoleTripwires.reports().at(-1)?.detail).toContain("refused to dispose");
  });

  it("reports a thrown value that has no message, rather than throwing describing it", () => {
    // A null-prototype value carrying no `toString` makes bare `String(...)` throw,
    // which would put the failure back on the path the backstop just took it off.
    const holder = new SubjectScopedHolder<string>();
    holder.address(SUBJECT_ONE, "alpha", () => "first");

    expect(() => {
      holder.address(
        SUBJECT_TWO,
        "alpha",
        () => "second",
        () => {
          throw Object.create(null) as unknown;
        },
      );
    }).not.toThrow();

    expect(holder.value).toBe("second");
    expect(consoleTripwires.firingCount("surface-render-failure")).toBe(1);
  });

  it("negative control: a disposal that returns records nothing", () => {
    // Without this, "recorded" above would be satisfied by a holder that reported on
    // every re-address — which would put a defect on the operator's diagnostics for
    // every ordinary route change.
    const holder = new SubjectScopedHolder<string>();
    let disposals = 0;
    holder.address(SUBJECT_ONE, "alpha", () => "first");
    holder.address(
      SUBJECT_TWO,
      "alpha",
      () => "second",
      () => {
        disposals += 1;
      },
    );

    expect(disposals).toBe(1);
    expect(consoleTripwires.firingCount("surface-render-failure")).toBe(0);
  });
});

describe("SubjectScopedHolder — a resource it refuses is disposed rather than dropped", () => {
  /** What the caller's disposal was handed, in order, so a double close is visible. */
  function holderDisposing(closed: string[]): SubjectScopedHolder<string> {
    return new SubjectScopedHolder<string>({
      disposeRejectedPublish: (rejected) => {
        closed.push(rejected);
      },
    });
  }

  it("closes a resource that settled into a visit which had already ended", () => {
    // The async open: a caller opened a connection for the visit on screen, the
    // surface was re-addressed while the open was in flight, and the settlement now
    // names a visit nothing is addressed at. Installed nowhere, it is reachable
    // through this disposal and through no other path in the program.
    const closed: string[] = [];
    const holder = holderDisposing(closed);
    holder.address(SUBJECT_ONE, "alpha", () => "the connection the first visit opened");
    const settlementFromTheVisitThatEnded = holder.publisherFor(SUBJECT_ONE, "alpha");
    holder.address(SUBJECT_TWO, "alpha", () => "the connection the second visit opened");

    settlementFromTheVisitThatEnded("the connection that opened too late");

    expect(closed).toStrictEqual(["the connection that opened too late"]);
    expect(holder.value).toBe("the connection the second visit opened");
    expect(consoleTripwires.firingCount("apply-chokepoint-bypass")).toBe(1);
    expect(consoleTripwires.reports().at(-1)?.detail).toContain("had already ended");
  });

  it("closes a resource offered to a capture taken before any subject", () => {
    // The one publisher that used to answer through a no-op of its own. A surface
    // about nothing yet can still have an open in flight, and the value it settles
    // with is as unreachable as any other the holder refuses.
    const closed: string[] = [];
    const holder = holderDisposing(closed);

    holder.settle()("the connection opened before there was a subject");

    expect(closed).toStrictEqual(["the connection opened before there was a subject"]);
    expect(consoleTripwires.firingCount("apply-chokepoint-bypass")).toBe(1);
  });

  it("refuses a function form without running it, so there is nothing to close", () => {
    // An update that never ran produced no value: disposing here would hand the
    // caller its own closure, and reporting would describe a resource that does not
    // exist.
    const closed: string[] = [];
    const holder = holderDisposing(closed);
    holder.address(SUBJECT_ONE, "alpha", () => "the first visit");
    const settlementFromTheVisitThatEnded = holder.publisherFor(SUBJECT_ONE, "alpha");
    holder.address(SUBJECT_TWO, "alpha", () => "the second visit");

    let updates = 0;
    settlementFromTheVisitThatEnded((previous) => {
      updates += 1;
      return previous;
    });

    expect(updates).toBe(0);
    expect(closed).toStrictEqual([]);
    expect(consoleTripwires.firingCount("apply-chokepoint-bypass")).toBe(0);
  });

  it("records the resource as held by nothing where its disposal throws", () => {
    // Escaping, this throw would reach whatever settled the publish — a caller's
    // `.then` — which is the same backstop the re-addressing path takes, and the
    // report has to say which of the two outcomes happened.
    const holder = new SubjectScopedHolder<string>({
      disposeRejectedPublish: () => {
        throw new Error("the connection this value owned refused to close");
      },
    });
    holder.address(SUBJECT_ONE, "alpha", () => "the first visit");
    const settlementFromTheVisitThatEnded = holder.publisherFor(SUBJECT_ONE, "alpha");
    holder.address(SUBJECT_TWO, "alpha", () => "the second visit");

    expect(() => {
      settlementFromTheVisitThatEnded("the connection that opened too late");
    }).not.toThrow();

    expect(holder.value).toBe("the second visit");
    expect(consoleTripwires.firingCount("apply-chokepoint-bypass")).toBe(1);
    expect(consoleTripwires.reports().at(-1)?.detail).toContain("held by nothing");
    expect(consoleTripwires.reports().at(-1)?.detail).toContain("refused to close");
  });

  it("negative control: a publish that lands is installed rather than closed", () => {
    // Without this, "closed" above would also be satisfied by a holder that disposed
    // every publish — which would close the resource the surface just opened for the
    // visit it is on.
    const closed: string[] = [];
    const holder = holderDisposing(closed);
    holder.address(SUBJECT_ONE, "alpha", () => "the connection the first visit opened");

    holder.publisherFor(SUBJECT_ONE, "alpha")("the connection that replaced it");

    expect(holder.value).toBe("the connection that replaced it");
    expect(closed).toStrictEqual([]);
    expect(consoleTripwires.firingCount("apply-chokepoint-bypass")).toBe(0);
  });

  it("negative control: a holder built with no disposal drops what it refuses", () => {
    // The plain state path, unchanged: a value is not a resource, and a holder that
    // reported every ordinary route change would put a defect on the operator's
    // diagnostics for a settlement the substrate is designed to drop.
    const holder = new SubjectScopedHolder<string>();
    holder.address(SUBJECT_ONE, "alpha", () => "seed");
    const settlementFromTheVisitThatEnded = holder.publisherFor(SUBJECT_ONE, "alpha");
    holder.address(SUBJECT_TWO, "alpha", () => "seed");

    settlementFromTheVisitThatEnded("the answer to a question nobody is asking");

    expect(holder.value).toBe("seed");
    expect(consoleTripwires.totalFiringCount).toBe(0);
  });
});
