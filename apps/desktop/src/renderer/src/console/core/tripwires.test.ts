// The tripwire registry, and the one claim its header makes that is easy to break.
//
// "It never silently passes: the record exists in both arms." A development build
// throws on a report, and a throw is exactly the control-flow that can strand the
// bookkeeping before it happens — record after the throw and the throwing arm keeps
// no evidence at all, which is the arm an author is most likely to catch and move
// past. The throwing cases below are therefore about what SURVIVES the throw.
//
// The kinds are walked from `TRIPWIRE_KINDS` rather than retyped, because the
// architecture tier's vacuity guard walks that same tuple: a test that named the
// four kinds itself could keep passing over a tuple that had lost one.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TRIPWIRE_REPORT_CAP } from "./constants.js";
import {
  TRIPWIRE_FIXTURE_GLOBAL,
  TRIPWIRE_KINDS,
  TripwireError,
  TripwireRegistry,
  consoleTripwires,
  reportTripwire,
  type TripwireReport,
} from "./tripwires.js";

function recordingRegistry(): TripwireRegistry {
  return new TripwireRegistry({ throwOnReport: false });
}

function reportFor(kind: TripwireReport["kind"]): TripwireReport {
  return { kind, site: `console/core/tripwires.test.ts:${kind}`, detail: "driven by a test" };
}

describe("TRIPWIRE_KINDS — the tuple every walk reads", () => {
  it("names at least one kind, so a walk over it is not vacuous", () => {
    expect(TRIPWIRE_KINDS.length).toBeGreaterThan(0);
  });

  it("names each kind once", () => {
    // A repeat would double-count a kind in every guard that walks the tuple while
    // the derived union stayed identical — the drift is invisible in the type.
    expect(new Set(TRIPWIRE_KINDS).size).toBe(TRIPWIRE_KINDS.length);
  });
});

describe("TripwireRegistry — recording", () => {
  it("records and counts every kind the tuple names", () => {
    const registry = recordingRegistry();
    for (const kind of TRIPWIRE_KINDS) {
      registry.report(reportFor(kind));
    }

    expect(registry.reports()).toHaveLength(TRIPWIRE_KINDS.length);
    expect(registry.totalFiringCount).toBe(TRIPWIRE_KINDS.length);
    for (const kind of TRIPWIRE_KINDS) {
      expect(registry.firingCount(kind), kind).toBe(1);
    }
  });

  it("reports zero for a kind that has not fired", () => {
    // Negative control for the counter: one that returned a constant would satisfy
    // every count above.
    const registry = recordingRegistry();
    registry.report(reportFor("bridge-shape-drift"));
    expect(registry.firingCount("apply-chokepoint-bypass")).toBe(0);
  });

  it("hands back a copy, so a reader cannot edit the evidence", () => {
    const registry = recordingRegistry();
    registry.report(reportFor("bridge-shape-drift"));

    // Equal contents, different array. A reader holding the registry's own buffer
    // could trim the record of a defect and leave the count claiming it happened.
    expect(registry.reports()).not.toBe(registry.reports());
    expect(registry.reports()).toStrictEqual(registry.reports());
  });
});

describe("TripwireRegistry — the buffer is bounded and the counter is not", () => {
  it("keeps the newest reports up to the cap and drops the oldest", () => {
    const registry = recordingRegistry();
    const overflow = TRIPWIRE_REPORT_CAP + 5;
    for (let index = 0; index < overflow; index += 1) {
      registry.report({
        kind: "apply-chokepoint-bypass",
        site: `site-${String(index)}`,
        detail: "driven by a test",
      });
    }

    const retained = registry.reports();
    expect(retained).toHaveLength(TRIPWIRE_REPORT_CAP);
    expect(retained[0]?.site).toBe("site-5");
    expect(retained.at(-1)?.site).toBe(`site-${String(overflow - 1)}`);
  });

  it("counts the firings the buffer no longer holds", () => {
    // "A tripwire that keeps firing is one defect, not thousands" only works as a
    // policy if the count survives the trimming; otherwise the buffer's bound would
    // silently bound the evidence too.
    const registry = recordingRegistry();
    const overflow = TRIPWIRE_REPORT_CAP + 5;
    for (let index = 0; index < overflow; index += 1) {
      registry.report(reportFor("apply-chokepoint-bypass"));
    }

    expect(registry.firingCount("apply-chokepoint-bypass")).toBe(overflow);
  });
});

describe("TripwireRegistry — loud in development, recorded in production", () => {
  it("throws a named error rather than one a test has to match on message text", () => {
    const registry = new TripwireRegistry({ throwOnReport: true });
    expect(() => {
      registry.report(reportFor("wire-figure-formatting"));
    }).toThrow(TripwireError);
  });

  it("leaves the record behind on the throwing arm too", () => {
    // The claim the header makes. Recording after the throw would lose the evidence
    // in exactly the arm where an author is most likely to catch and move on.
    const registry = new TripwireRegistry({ throwOnReport: true });
    try {
      registry.report(reportFor("wire-figure-formatting"));
    } catch (tripwireFailure: unknown) {
      expect(tripwireFailure).toBeInstanceOf(TripwireError);
      expect((tripwireFailure as TripwireError).kind).toBe("wire-figure-formatting");
    }

    expect(registry.firingCount("wire-figure-formatting")).toBe(1);
    expect(registry.reports()).toHaveLength(1);
  });

  it("takes the arm from the shell at boot rather than fixing it at construction", () => {
    const registry = recordingRegistry();
    registry.report(reportFor("bridge-shape-drift"));

    registry.setThrowOnReport(true);

    expect(() => {
      registry.report(reportFor("bridge-shape-drift"));
    }).toThrow(TripwireError);
    expect(registry.firingCount("bridge-shape-drift")).toBe(2);
  });
});

describe("TripwireRegistry — the diagnostic sinks", () => {
  it("delivers every report to every subscriber", () => {
    const registry = recordingRegistry();
    const firstSeen: TripwireReport[] = [];
    const secondSeen: TripwireReport[] = [];
    registry.subscribeToReports((report) => firstSeen.push(report));
    registry.subscribeToReports((report) => secondSeen.push(report));

    registry.report(reportFor("persistence-value-class"));

    // Two subscribers rather than one: the registry used to hold a single
    // replaceable sink, where the second install silently dropped the first.
    expect(firstSeen).toHaveLength(1);
    expect(secondSeen).toHaveLength(1);
  });

  it("stops delivering to a subscriber that detached, and keeps recording", () => {
    const registry = recordingRegistry();
    const seen: TripwireReport[] = [];
    const unsubscribe = registry.subscribeToReports((report) => seen.push(report));

    registry.report(reportFor("persistence-value-class"));
    unsubscribe();
    registry.report(reportFor("persistence-value-class"));

    // The detach is real (one delivery, not two) and the registry is unaffected by
    // it (two firings) — a sink is a diagnostic tap, never the record itself.
    expect(seen).toHaveLength(1);
    expect(registry.firingCount("persistence-value-class")).toBe(2);
  });

  it("does not replay past reports to a subscriber that arrives later", () => {
    const registry = recordingRegistry();
    registry.report(reportFor("persistence-value-class"));

    const seen: TripwireReport[] = [];
    registry.subscribeToReports((report) => seen.push(report));

    expect(seen).toStrictEqual([]);
  });
});

describe("TripwireRegistry — reset clears the evidence and nothing else", () => {
  it("forgets reports and counts", () => {
    const registry = recordingRegistry();
    registry.report(reportFor("bridge-shape-drift"));

    registry.reset();

    expect(registry.reports()).toStrictEqual([]);
    expect(registry.totalFiringCount).toBe(0);
    expect(registry.firingCount("bridge-shape-drift")).toBe(0);
  });

  it("keeps the subscribers and the throwing arm, so it cannot disarm the next case", () => {
    const registry = new TripwireRegistry({ throwOnReport: true });
    const seen: TripwireReport[] = [];
    registry.subscribeToReports((report) => seen.push(report));

    registry.reset();

    expect(() => {
      registry.report(reportFor("bridge-shape-drift"));
    }).toThrow(TripwireError);
    expect(seen).toHaveLength(1);
  });
});

describe("the console's own registry", () => {
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

  it("is what reportTripwire writes to", () => {
    reportTripwire("apply-chokepoint-bypass", "console/core/tripwires.test.ts", "driven by a test");

    expect(consoleTripwires.firingCount("apply-chokepoint-bypass")).toBe(1);
    expect(consoleTripwires.reports()[0]?.site).toBe("console/core/tripwires.test.ts");
  });

  it("is reachable through the fixture global under the fixture define", () => {
    // The endurance tier drives a real window from outside the renderer and can
    // only read this registry through the page. If the handle were missing, that
    // tier would treat an unreachable registry as nothing to assert.
    const page = globalThis as Record<string, unknown>;
    expect(page[TRIPWIRE_FIXTURE_GLOBAL]).toBe(consoleTripwires);
  });
});
