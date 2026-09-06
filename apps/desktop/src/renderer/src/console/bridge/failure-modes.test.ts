// Failure modes of the outside-world seam.
//
// The class: the bridge is the only place the console reaches something it does not
// own, and both halves of that reach can lie. A scenario engine can outlive the
// store it feeds and deliver a tick into a torn-down subscriber; a growth port can
// claim a wire is fixture-only after the wire has landed, or refuse an operation the
// ledger never heard of. Either way a surface above reads a plausible answer that is
// not true, which is the one failure this family exists to make impossible.
//
// They live in `bridge/` because the subject is what crosses the seam: the engine's
// lifecycle and the port-and-ledger pair that `Plan-023 §Console growth slate` is
// audited against. The store that receives the delivered events asserts its own
// admission rules in `store/failure-modes.test.ts` — the split follows the seam.
//
// Where a mode has a "the code should have refused" shape, the assertion is on the
// REFUSAL — its dropped-tick count, its tripwire, its `unavailable` status and the
// document it names — rather than merely on the absence of a crash. A port that
// answered `[]` instead of refusing would pass a does-not-throw assertion while
// telling a surface that there are none, when the truth is that nobody asked.

import { beforeEach, describe, expect, it } from "vitest";

import { SCENARIO_TICK_MS } from "../core/index.js";
import { consoleTripwires } from "../core/tripwires.js";
import type { ConsoleSessionEvent } from "../store/index.js";
import { GROWTH_OPERATIONS } from "./growth-operations/index.js";
import { createRefusingGrowthPort, growthUnavailable } from "./growth-port/growth-port.js";
import { GROWTH_PREREQUISITES } from "./growth-port/growth-prerequisites.js";
import { GROWTH_SLATE_ROWS, type GrowthSlateRow } from "./growth-port/growth-slate.js";
import {
  consoleScenarioManifest,
  findOrphanedLedgerRowIds,
  mapSlateRowCoverage,
  type ConsoleScenarioManifest,
} from "./scenario-runtime/scenario-manifest.js";
import { ScenarioEngine } from "./scenario-runtime/scenario-engine.js";
import { FIRST_RUN_SCENARIO } from "./scenarios/first-run.js";

// Tripwires throw in development so a breach is impossible to ignore. Under test
// they are RECORDED instead, because the point of these cases is to assert that the
// breach was detected and described — a throw would only prove it was noticed.
beforeEach(() => {
  consoleTripwires.setThrowOnReport(false);
  consoleTripwires.reset();
});

describe("failure matrix — a scenario tick arrives after teardown", () => {
  it("drops the tick, counts it, and reports rather than delivering into a dead store", () => {
    const engine = new ScenarioEngine({ scenario: FIRST_RUN_SCENARIO });
    const delivered: ConsoleSessionEvent[][] = [];
    engine.subscribe((events) => {
      delivered.push([...events]);
    });

    engine.dispose();
    // BOTH entry points, because they are two ways into one drop and a case that
    // exercised one would leave the other free to deliver into the disposed store:
    // `tick()` is what a live engine's own timer calls, and `advance` is what a
    // caller holding a duration calls. The duration is the engine's own tick
    // interval rather than a number chosen here — the magnitude decides nothing
    // after teardown, and a literal invites a reader to look for the meaning it has
    // in the live path.
    engine.tick();
    engine.advance(SCENARIO_TICK_MS);

    expect(delivered).toHaveLength(0);
    expect(engine.droppedTickCount).toBe(2);
    expect(consoleTripwires.firingCount("apply-chokepoint-bypass")).toBe(2);
  });

  it("delivers normally before teardown, so the drop is not vacuous", () => {
    const engine = new ScenarioEngine({ scenario: FIRST_RUN_SCENARIO });
    const delivered: ConsoleSessionEvent[][] = [];
    engine.subscribe((events) => {
      delivered.push([...events]);
    });

    engine.runToCompletion();

    expect(delivered).toHaveLength(1);
    expect(engine.progress.isComplete).toBe(true);
  });
});

describe("failure matrix — a growth-slate row lands and the port still claims fixture-only", () => {
  it("has every slate row served by at least one operation or prerequisite", () => {
    const uncovered = mapSlateRowCoverage().filter(
      (coverage) => coverage.operations.length === 0 && coverage.prerequisites.length === 0,
    );
    expect(uncovered.map((coverage) => coverage.row.id)).toStrictEqual([]);
  });

  it("has no ledger entry naming a row that is not on the slate", () => {
    expect(findOrphanedLedgerRowIds()).toStrictEqual([]);
  });

  it("agrees with the slate: every entry is fixture-only while its row is unregistered", () => {
    for (const entry of [
      ...consoleScenarioManifest().growthOperations,
      ...consoleScenarioManifest().prerequisites,
    ]) {
      expect(entry.liveStatus).toBe("fixture-only");
    }
    for (const row of GROWTH_SLATE_ROWS) {
      expect(row.wireRegistered).toBe(false);
    }
  });

  it("fails when a row is registered and its entries have not been re-pointed", () => {
    // The day a wire lands, its row leaves the slate. This drives that day: a
    // manifest whose slate no longer carries a row its entries still name must be
    // caught, not quietly tolerated.
    const manifest = consoleScenarioManifest();
    const withoutBrowserRow: ConsoleScenarioManifest = {
      ...manifest,
      slateRows: manifest.slateRows.filter(
        (row: GrowthSlateRow) => row.id !== "browser-pane-namespace",
      ),
    };

    expect(findOrphanedLedgerRowIds(withoutBrowserRow)).toContain("browser-pane-namespace");
  });

  it("refuses every operation under the live bridge, as the not-checked absence", async () => {
    const port = createRefusingGrowthPort();
    const outcome = await port.invitesList({ sessionId: "session-1" });

    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") {
      expect(outcome.detail).toContain("Not checked");
      expect(outcome.owningDocument).toContain("Spec-002");
    }
    // Not an empty list. "We have not asked" and "there are none" are different
    // facts, and a surface handed `[]` cannot tell them apart.
    expect(outcome).not.toHaveProperty("value");
  });

  it("exposes one port method per operation entry and none per prerequisite", () => {
    const port = createRefusingGrowthPort();
    const portMethodNames = Object.keys(port).sort();
    const operationIds = Object.keys(GROWTH_OPERATIONS).sort();

    expect(portMethodNames).toStrictEqual(operationIds);
    for (const prerequisiteId of Object.keys(GROWTH_PREREQUISITES)) {
      expect(portMethodNames).not.toContain(prerequisiteId);
    }
  });

  it("names the owning document on every refusal's ledger member, never in its sentence", () => {
    // The structured member is for the ledger; the sentence is what a person reads,
    // and a governance document's name is not product vocabulary.
    for (const operationId of Object.keys(GROWTH_OPERATIONS)) {
      const refusal = growthUnavailable(operationId as keyof typeof GROWTH_OPERATIONS);
      expect(refusal.owningDocument.length).toBeGreaterThan(0);
      expect(refusal.detail).toContain("not registered on this build yet");
      expect(refusal.detail).not.toContain(refusal.owningDocument);
    }
  });
});
