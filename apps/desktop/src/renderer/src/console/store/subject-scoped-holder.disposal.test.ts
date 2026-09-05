// What becomes of a value the holder let go of, and what it says about it.
//
// The other half of `subject-scoped-holder.test.ts`, on the seam the source draws:
// that file is about WHO MAY WRITE — which addressing a publisher names and whether a
// settlement is admitted — and this one is about the value that write refused or
// replaced, and the value a proposal no render committed left behind. All three rules
// live in `unheld-value-disposal.ts`, behind one seam the holder is handed at
// construction, and are driven here through the holder's own door because a caller
// reaches them no other way.
//
// Tripwires throw in a development build, which would turn the backstops below into
// the very escaping throws they exist to prevent. The recording arm is the one under
// test, exactly as it is for the surface error boundary next door.
//
// Every clean assertion is paired with a NEGATIVE CONTROL, because "the value was
// disposed" is also satisfied by a holder that disposed everything it touched — which
// would close the resource the frame on screen is reading through.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { consoleTripwires } from "../core/tripwires.js";
import { SUBJECT_ONE, SUBJECT_TWO } from "./subject-fixtures.test-support.js";
import { visit } from "./subject-scoped-drivers.test-support.js";
import { SubjectScopedHolder } from "./subject-scoped-holder.js";

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

describe("SubjectScopedHolder — a disposal that throws does not take the render with it", () => {
  /** The value a pass proposed, which the case that supersedes it cannot dispose. */
  const UNDISPOSABLE = "the value that owns a registry";

  it("leaves the proposal that superseded it addressed and publishable, and records why", () => {
    // This runs inside a render body. Escaping, the throw reaches the surface's error
    // boundary, which unmounts the subtree on top of a holder whose newest proposal is
    // already installed and reachable through nothing — so the resource the disposal
    // was clearing room for is held by nothing AND the surface is gone.
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
    expect(consoleTripwires.firingCount("surface-render-failure")).toBe(1);
    expect(consoleTripwires.reports().at(-1)?.detail).toContain("refused to dispose");
    // And the pass that superseded it can still settle into what it addressed, which
    // is what "the render was not taken with it" means from the caller's side.
    holder.publisherFor(SUBJECT_TWO, "beta")("what the new pass read");
    expect(holder.value).toBe("what the new pass read");
    expect(consoleTripwires.firingCount("apply-chokepoint-bypass")).toBe(0);
  });

  it("reports a thrown value that has no message, rather than throwing describing it", () => {
    // A null-prototype value carrying no `toString` makes bare `String(...)` throw,
    // which would put the failure back on the path the backstop just took it off.
    const holder = new SubjectScopedHolder<string>({
      disposeUnheldValue: () => {
        throw Object.create(null) as unknown;
      },
    });
    visit(holder, SUBJECT_ONE, "alpha", () => "the visit on screen");
    holder.address(SUBJECT_TWO, "alpha", () => "first");

    expect(() => {
      holder.address(SUBJECT_TWO, "beta", () => "second");
    }).not.toThrow();

    expect(holder.value).toBe("second");
    expect(consoleTripwires.firingCount("surface-render-failure")).toBe(1);
  });

  it("negative control: a disposal that returns records nothing", () => {
    // Without this, "recorded" above would be satisfied by a holder that reported on
    // every discarded proposal — which would put a defect on the operator's
    // diagnostics for every render React throws away, which is routine.
    let disposals = 0;
    const holder = new SubjectScopedHolder<string>({
      disposeUnheldValue: () => {
        disposals += 1;
      },
    });
    visit(holder, SUBJECT_ONE, "alpha", () => "the visit on screen");
    holder.address(SUBJECT_TWO, "alpha", () => "first");
    holder.address(SUBJECT_TWO, "beta", () => "second");

    expect(disposals).toBe(1);
    expect(consoleTripwires.firingCount("surface-render-failure")).toBe(0);
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
    // The async open: a caller opened a connection for the visit on screen, the
    // surface was re-addressed while the open was in flight, and the settlement now
    // names a visit nothing is addressed at. Installed nowhere, it is reachable
    // through this disposal and through no other path in the program.
    const closed: string[] = [];
    const holder = holderDisposing(closed);
    visit(holder, SUBJECT_ONE, "alpha", () => "the connection the first visit opened");
    const settlementFromTheVisitThatEnded = holder.publisherFor(SUBJECT_ONE, "alpha");
    visit(holder, SUBJECT_TWO, "alpha", () => "the connection the second visit opened");

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
    visit(holder, SUBJECT_ONE, "alpha", () => "the first visit");
    const settlementFromTheVisitThatEnded = holder.publisherFor(SUBJECT_ONE, "alpha");
    visit(holder, SUBJECT_TWO, "alpha", () => "the second visit");

    let updates = 0;
    settlementFromTheVisitThatEnded((previous) => {
      updates += 1;
      return previous;
    });

    expect(updates).toBe(0);
    expect(closed).toStrictEqual([]);
    expect(consoleTripwires.firingCount("apply-chokepoint-bypass")).toBe(0);
  });

  it("hands a resource a later publish replaced to the same disposal", () => {
    // Two direct publishes in one batched event: the first replacement is installed
    // and replaced again with no commit in between, so no effect ever closed over it
    // and the re-addressing path never sees it. The holder's own write is the last
    // moment anything in the program can reach it.
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
    // Ordinary, so nothing is reported: replacing a held value by publishing is how a
    // window replaces a store that closed itself, and a report per publish would put
    // a defect on the operator's diagnostics for the substrate working.
    expect(consoleTripwires.totalFiringCount).toBe(0);
  });

  it("hands over the value a FUNCTION-form publish replaced, once it has run", () => {
    // The function form is refused without running where the visit has ended, so
    // nothing is disposed there. Where it lands it produces a value like any other,
    // and the one it replaced is as unreachable as any other.
    const closed: string[] = [];
    const holder = holderDisposing(closed);
    visit(holder, SUBJECT_ONE, "alpha", () => "the first connection");

    holder.publisherFor(SUBJECT_ONE, "alpha")((previous) => `${previous}, replaced`);

    expect(closed).toStrictEqual(["the first connection"]);
    expect(holder.value).toBe("the first connection, replaced");
  });

  it("disposes nothing for a publish that changes nothing", () => {
    // The value was not replaced — it is the one still held — so handing it over
    // would close the resource the surface is reading through.
    const closed: string[] = [];
    const holder = holderDisposing(closed);
    visit(holder, SUBJECT_ONE, "alpha", () => "the only connection");

    holder.publisherFor(SUBJECT_ONE, "alpha")("the only connection");

    expect(closed).toStrictEqual([]);
    expect(holder.value).toBe("the only connection");
  });

  it("records a replaced value as held by nothing where its disposal throws", () => {
    const holder = new SubjectScopedHolder<string>({
      disposeUnheldValue: () => {
        throw new Error("the connection this value owned refused to close");
      },
    });
    visit(holder, SUBJECT_ONE, "alpha", () => "the first connection");

    expect(() => {
      holder.publisherFor(SUBJECT_ONE, "alpha")("the connection that replaced it");
    }).not.toThrow();

    expect(holder.value).toBe("the connection that replaced it");
    expect(consoleTripwires.firingCount("apply-chokepoint-bypass")).toBe(1);
    expect(consoleTripwires.reports().at(-1)?.detail).toContain("held by nothing");
    expect(consoleTripwires.reports().at(-1)?.detail).toContain("refused to close");
  });

  it("negative control: a plain holder disposes nothing a publish replaced", () => {
    // A value is not a resource. The plain state path drops what it replaces exactly
    // as before, and a holder that reported here would fire on every settlement the
    // console makes.
    const holder = new SubjectScopedHolder<string>();
    visit(holder, SUBJECT_ONE, "alpha", () => "seed");

    holder.publisherFor(SUBJECT_ONE, "alpha")("published");
    holder.publisherFor(SUBJECT_ONE, "alpha")("published again");

    expect(holder.value).toBe("published again");
    expect(consoleTripwires.totalFiringCount).toBe(0);
  });

  it("records the resource as held by nothing where its disposal throws", () => {
    // Escaping, this throw would reach whatever settled the publish — a caller's
    // `.then` — which is the same backstop the re-addressing path takes, and the
    // report has to say which of the two outcomes happened.
    const holder = new SubjectScopedHolder<string>({
      disposeUnheldValue: () => {
        throw new Error("the connection this value owned refused to close");
      },
    });
    visit(holder, SUBJECT_ONE, "alpha", () => "the first visit");
    const settlementFromTheVisitThatEnded = holder.publisherFor(SUBJECT_ONE, "alpha");
    visit(holder, SUBJECT_TWO, "alpha", () => "the second visit");

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
    // visit it is on. What the holder lets go of is the value that was REPLACED, and
    // never the one it now holds; whether that replaced value may actually be
    // released is the caller's question, and the resource hook answers it by refusing
    // to close what a live effect is holding.
    const closed: string[] = [];
    const holder = holderDisposing(closed);
    visit(holder, SUBJECT_ONE, "alpha", () => "the connection the first visit opened");

    holder.publisherFor(SUBJECT_ONE, "alpha")("the connection that replaced it");

    expect(holder.value).toBe("the connection that replaced it");
    expect(closed).not.toContain("the connection that replaced it");
    expect(consoleTripwires.firingCount("apply-chokepoint-bypass")).toBe(0);
  });

  it("negative control: a holder built with no disposal drops what it refuses", () => {
    // The plain state path, unchanged: a value is not a resource, and a holder that
    // reported every ordinary route change would put a defect on the operator's
    // diagnostics for a settlement the substrate is designed to drop.
    const holder = new SubjectScopedHolder<string>();
    visit(holder, SUBJECT_ONE, "alpha", () => "seed");
    const settlementFromTheVisitThatEnded = holder.publisherFor(SUBJECT_ONE, "alpha");
    visit(holder, SUBJECT_TWO, "alpha", () => "seed");

    settlementFromTheVisitThatEnded("the answer to a question nobody is asking");

    expect(holder.value).toBe("seed");
    expect(consoleTripwires.totalFiringCount).toBe(0);
  });
});
