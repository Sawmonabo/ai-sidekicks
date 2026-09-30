// What becomes of a value the holder let go of: one a publish refused, one it replaced, and one a
// proposal no render committed left behind. The rules live in `unheld-value-disposal.ts` and are
// driven through the holder's API; who may write is in `subject-scoped-holder.test.ts`.
//
// Tripwires throw in a development build, which would turn the backstops into the escaping throws
// they prevent, so the recording arm is the one under test. Each clean assertion has a negative
// control, since "the value was disposed" is also satisfied by a holder that disposed everything,
// including the resource the screen reads through.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { windowTripwires } from "../tripwires.js";
import { SUBJECT_ONE, SUBJECT_TWO } from "@test/helpers/subject-fixtures.js";
import { visit } from "./subject-scoped-holder.test-support.js";
import { SubjectScopedHolder } from "./subject-scoped-holder.js";

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
    expect(windowTripwires.firingCount("apply-chokepoint-bypass")).toBe(0);
  });

  it("reports a thrown value that has no message, rather than throwing describing it", () => {
    // A null-prototype value has no `toString`, so bare `String(...)` would throw in the report.
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
    expect(windowTripwires.firingCount("region-render-failure")).toBe(1);
  });

  it("negative control: a disposal that returns records nothing", () => {
    // Without this, "recorded" above would pass for a holder reporting every discarded proposal,
    // which React does routinely.
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
    expect(windowTripwires.firingCount("region-render-failure")).toBe(0);
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
    expect(windowTripwires.firingCount("apply-chokepoint-bypass")).toBe(1);
    expect(windowTripwires.reports().at(-1)?.detail).toContain("had already ended");
  });

  it("closes a resource offered to a capture taken before any subject", () => {
    // A component about nothing yet can still have an open in flight, and the value it settles
    // with is as unreachable as any other the holder refuses.
    const closed: string[] = [];
    const holder = holderDisposing(closed);

    holder.settle()("the connection opened before there was a subject");

    expect(closed).toStrictEqual(["the connection opened before there was a subject"]);
    expect(windowTripwires.firingCount("apply-chokepoint-bypass")).toBe(1);
  });

  it("refuses a function form without running it, so there is nothing to close", () => {
    // An update that never ran produced no value; disposing would hand back the caller's closure.
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
    expect(windowTripwires.firingCount("apply-chokepoint-bypass")).toBe(0);
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

  it("hands over the value a FUNCTION-form publish replaced, once it has run", () => {
    // The function form is refused unrun where the visit ended, so nothing is disposed there;
    // where it lands, the value it replaced is as unreachable as any other.
    const closed: string[] = [];
    const holder = holderDisposing(closed);
    visit(holder, SUBJECT_ONE, "alpha", () => "the first connection");

    holder.publisherFor(SUBJECT_ONE, "alpha")((previous) => `${previous}, replaced`);

    expect(closed).toStrictEqual(["the first connection"]);
    expect(holder.value).toBe("the first connection, replaced");
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
    expect(windowTripwires.firingCount("apply-chokepoint-bypass")).toBe(1);
    expect(windowTripwires.reports().at(-1)?.detail).toContain("held by nothing");
    expect(windowTripwires.reports().at(-1)?.detail).toContain("refused to close");
  });

  it("negative control: a plain holder disposes nothing a publish replaced", () => {
    // A value is not a resource: the plain path drops what it replaces without reporting.
    const holder = new SubjectScopedHolder<string>();
    visit(holder, SUBJECT_ONE, "alpha", () => "seed");

    holder.publisherFor(SUBJECT_ONE, "alpha")("published");
    holder.publisherFor(SUBJECT_ONE, "alpha")("published again");

    expect(holder.value).toBe("published again");
    expect(windowTripwires.totalFiringCount).toBe(0);
  });

  it("records the resource as held by nothing where its disposal throws", () => {
    // Escaping, this throw would reach the caller's `.then`; the report names the outcome.
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
    expect(windowTripwires.firingCount("apply-chokepoint-bypass")).toBe(1);
    expect(windowTripwires.reports().at(-1)?.detail).toContain("held by nothing");
    expect(windowTripwires.reports().at(-1)?.detail).toContain("refused to close");
  });

  it("negative control: a publish that lands is installed rather than closed", () => {
    // Without this, "closed" above would pass for a holder that disposed every publish. It lets go
    // of the replaced value, never the one it holds; whether that may be released is the resource
    // hook's question.
    const closed: string[] = [];
    const holder = holderDisposing(closed);
    visit(holder, SUBJECT_ONE, "alpha", () => "the connection the first visit opened");

    holder.publisherFor(SUBJECT_ONE, "alpha")("the connection that replaced it");

    expect(holder.value).toBe("the connection that replaced it");
    expect(closed).not.toContain("the connection that replaced it");
    expect(windowTripwires.firingCount("apply-chokepoint-bypass")).toBe(0);
  });

  it("negative control: a holder built with no disposal drops what it refuses", () => {
    // The plain path: a value is not a resource, and reporting every route change would flag a
    // settlement the substrate is designed to drop.
    const holder = new SubjectScopedHolder<string>();
    visit(holder, SUBJECT_ONE, "alpha", () => "seed");
    const settlementFromTheVisitThatEnded = holder.publisherFor(SUBJECT_ONE, "alpha");
    visit(holder, SUBJECT_TWO, "alpha", () => "seed");

    settlementFromTheVisitThatEnded("the answer to a question nobody is asking");

    expect(holder.value).toBe("seed");
    expect(windowTripwires.totalFiringCount).toBe(0);
  });
});
