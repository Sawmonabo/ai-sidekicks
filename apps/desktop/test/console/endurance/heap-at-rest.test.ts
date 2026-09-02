// The renderer heap-at-rest budget, measured — Plan-023 Phase 1C.
//
// `Spec-023 §Console Design (Meridian)` §Budgets row 3 bounds "renderer heap, one
// session open at rest" at 120 MB, and `budgets.json` carries the ceiling. This
// file is the row's `measuredBy`: it takes the reading and compares it through
// the registry's own `evaluateBudget`, so the number this gate uses and the
// number the spec wrote are the same number read from one file.
//
// WHY THE READING LIVES ON THE ENDURANCE TIER AND NOT IN THE BUDGET CLI
//
// The figure is a RENDERER heap. `scripts/budget/measure-heap.mts` runs in a Node
// process that holds no Chromium, no V8 renderer isolate, no React, no DOM, and
// no console store, so every figure available there is short of the shipped
// renderer by everything that makes a renderer — which is why that harness
// deliberately measures nothing and refuses to be named this row's measurer. The
// only process that holds the subject is the built console itself, which is what
// this tier launches.
//
// WHY THE READING IS TAKEN HERE AND NOT IN `steady-state.test.ts`
//
// Two different claims. That file bounds how far the heap MOVES over sustained
// use and owns no ceiling; this one bounds what the heap IS at one quiet instant
// and owns no growth rule. Putting both in one file would put one number under
// two owners, which is how a budget gets loosened in one place and stays enforced
// in the other.
//
// WHAT MAKES THE INSTANT THE BUDGET'S SUBJECT
//
// "One session open at rest" is three conditions, and the run establishes each
// rather than assuming it:
//
//   • **One session open.** The console is launched on the flagship scenario and
//     navigated to that scenario's own session route, and the navigation is
//     observed on a surface only that route renders.
//   • **With content.** The frozen clock is walked over the whole script, and the
//     session store's ADMITTED event count is asserted non-zero against a live
//     wire subscription. A reading over an empty store measures the substrate,
//     not this budget's subject — which is precisely why this row recorded itself
//     unmeasurable until the fixture bridge served the session read.
//   • **At rest.** Nothing in a fixture build moves the frozen clock on its own,
//     so the console is idle from the last advance onwards. The heap is then read
//     as the minimum over settling samples, which is the tier's one heap
//     instrument and is shared rather than restated.

import process from "node:process";

import { describe, expect, it } from "vitest";

import { fixtureBundleExists, launchConsole } from "../electron-harness.js";
import {
  deliverWholeScenario,
  expectFlagshipSessionCarriesContent,
  openFlagshipSessionRoute,
  readSettledHeapBytes,
} from "./console-workload.js";
import { FLAGSHIP_SCENARIO } from "../../../src/renderer/src/console/bridge/scenarios/flagship.js";
import {
  ConsoleBudgetRegistry,
  evaluateBudget,
  type ConsoleBudget,
} from "../../../scripts/budget/budget-registry.mjs";

const bundleIsBuilt = fixtureBundleExists();

/** The row this file measures. Named once; every figure below comes off it. */
const HEAP_AT_REST_BUDGET_ID = "renderer-heap-at-rest";

const registry = ConsoleBudgetRegistry.load();
const budget = registry.requireBudget(HEAP_AT_REST_BUDGET_ID);

/**
 * The row rewritten with a ceiling one byte under whatever was measured.
 *
 * The negative control, and it drives the REAL comparison rather than a
 * re-implementation of `<=`: without it, an `evaluateBudget` that returned
 * `withinBudget: true` unconditionally would satisfy the assertion above and this
 * gate would report green over any renderer at all.
 */
function budgetWithCeilingBelow(measuredCanonicalValue: number): ConsoleBudget {
  return {
    ...budget,
    limit: { ...budget.limit, canonicalValue: measuredCanonicalValue - 1 },
  };
}

describe("the renderer heap-at-rest budget row", () => {
  // The ceiling, the unit, and the row's `n/a`-versus-`enforced` consistency are
  // the budget tier's to hold (`test/console/budget/heap-budget.test.ts`) and are
  // deliberately not restated here. What only THIS file can say is that it is the
  // harness the row names — so a reading that moves away, or a row flipped back
  // to ungated while this gate keeps running and passing, fails here.
  it("is the harness the row names as its measurer", () => {
    expect(budget.status).toBe("enforced");
    expect(budget.measuredBy).toBe("apps/desktop/test/console/endurance/heap-at-rest.test.ts");
  });
});

describe.skipIf(!bundleIsBuilt)("endurance — the console at rest with one session open", () => {
  it("holds the renderer heap under the budget's ceiling", async () => {
    const consoleApplication = await launchConsole({ scenarioId: FLAGSHIP_SCENARIO.id });
    try {
      await openFlagshipSessionRoute(consoleApplication);
      const deliveredBeatCount = await deliverWholeScenario(consoleApplication);
      expect(
        deliveredBeatCount,
        "the scenario handle is not exposed by this build, so nothing drove content into the session being measured",
      ).not.toBeNull();
      expect(Number(deliveredBeatCount)).toBe(FLAGSHIP_SCENARIO.beats.length);
      await expectFlagshipSessionCarriesContent(consoleApplication);

      const atRestHeapBytes = await readSettledHeapBytes(consoleApplication);
      const verdict = evaluateBudget(budget, atRestHeapBytes);

      // Reported before the assertion, on the same reasoning the steady-state run
      // prints its growth: a gate that speaks only when it fails gives a reviewer
      // no way to watch a margin shrink over months until the day it crosses.
      process.stdout.write(
        `[console-endurance] heap at rest ${String(Math.round(atRestHeapBytes / 1024))} kB ` +
          `of ${String(Math.round(budget.limit.canonicalValue / 1024))} kB ` +
          `(${(verdict.utilizationFraction * 100).toFixed(1)} % of budget) with ` +
          `${String(deliveredBeatCount)} beats delivered into one open session\n`,
      );

      expect(
        verdict.withinBudget,
        `${budget.label}: ${String(atRestHeapBytes)} B against a ${String(budget.limit.canonicalValue)} B ceiling`,
      ).toBe(true);

      // A ceiling planted one byte under the reading must fail the same
      // comparison this gate just passed.
      expect(
        evaluateBudget(budgetWithCeilingBelow(atRestHeapBytes), atRestHeapBytes).withinBudget,
      ).toBe(false);
    } finally {
      await consoleApplication.close();
    }
  });
});
