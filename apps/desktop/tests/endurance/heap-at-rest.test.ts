// The renderer heap-at-rest budget: the heap with one session open at rest stays under the
// ceiling in `budgets.json`, compared through the registry's own `evaluateBudget`.
//
// The reading is taken here, not in the budget CLI: the figure is a renderer heap, and the
// Node process behind `scripts/budget/measure-heap.mts` holds no Chromium, React, DOM or
// console store, so it deliberately measures nothing. Only the built console holds the subject.
// It is not taken in `steady-state.test.ts` either: that file bounds how far the heap moves and
// owns no ceiling, this one bounds what the heap is at one quiet instant and owns no growth
// rule, so no number has two owners.
//
// "One session open at rest" is established by the run, not assumed:
//   - One session open: the console launches on the concurrent-streaming scenario and navigates
//     to its session route, observed on markup only that route renders.
//   - With content: the frozen clock walks the whole script and the session store's admitted
//     event count is asserted non-zero, since a reading over an empty store measures the
//     substrate.
//   - At rest: nothing in a fixture build moves the frozen clock on its own. The heap is read
//     through the tier's one instrument (a forced collection, then the minimum over settling
//     samples); a bare sampler would carry the four megabytes the precision precondition
//     allocates and drops a few round trips earlier.

import process from "node:process";

import { describe, expect, it } from "vitest";

import { withLaunchedApp } from "../helpers/electron-harness.js";
import { fixtureBundleExists } from "../helpers/fixture-bundle.js";
import {
  deliverWholeScenario,
  ENDURANCE_LAUNCH_OPTIONS,
  expectConcurrentStreamingSessionCarriesContent,
  openConcurrentStreamingSessionRoute,
} from "./endurance-workload.js";
import { expectPreciseHeapInstrument, RendererHeapProbe } from "./heap-instrument.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../fixtures/scenarios/concurrent-streaming.js";
import { BudgetRegistry } from "../../scripts/budget/budget-registry.mjs";
import { evaluateBudget } from "../../scripts/budget/budget-evaluation.mjs";
import { type Budget } from "../../scripts/budget/budget-document.mjs";

const bundleIsBuilt = fixtureBundleExists();

/** The budget row this file measures. */
const HEAP_AT_REST_BUDGET_ID = "renderer-heap-at-rest";

const registry = BudgetRegistry.load();
const budget = registry.requireBudget(HEAP_AT_REST_BUDGET_ID);

/**
 * The row rewritten with a ceiling one byte under whatever was measured.
 *
 * The negative control drives the real comparison, so an `evaluateBudget` that always returned
 * `withinBudget: true` cannot leave this gate green over any renderer.
 */
function budgetWithCeilingBelow(measuredCanonicalValue: number): Budget {
  return {
    ...budget,
    limit: { ...budget.limit, canonicalValue: measuredCanonicalValue - 1 },
  };
}

describe("the renderer heap-at-rest budget row", () => {
  // The ceiling, the unit and the row's `n/a`-versus-`enforced` consistency belong to the
  // budget tier (`scripts/budget/measure-heap.test.ts`). This checks only that the row names
  // this file as its measurer and is still enforced.
  it("is the harness the row names as its measurer", () => {
    expect(budget.status).toBe("enforced");
    expect(budget.measuredBy).toBe("apps/desktop/tests/endurance/heap-at-rest.test.ts");
  });
});

describe.skipIf(!bundleIsBuilt)("endurance — the console at rest with one session open", () => {
  it("holds the renderer heap under the budget's ceiling", async () => {
    await withLaunchedApp(ENDURANCE_LAUNCH_OPTIONS, async (consoleApplication) => {
      await openConcurrentStreamingSessionRoute(consoleApplication);
      const deliveredBeatCount = await deliverWholeScenario(consoleApplication);
      expect(
        deliveredBeatCount,
        "the scenario handle is not exposed by this build, so nothing drove content into the session being measured",
      ).not.toBeNull();
      expect(Number(deliveredBeatCount)).toBe(CONCURRENT_STREAMING_SCENARIO.beats.length);
      await expectConcurrentStreamingSessionCarriesContent(consoleApplication);

      // Attached before the precondition, which needs it: the precondition takes each of its
      // two readings behind this reader's forced collection, so the difference is the probe's
      // allocation and not whatever the collector reclaimed in between.
      const heapProbe = await RendererHeapProbe.attachTo(consoleApplication);
      let atRestHeapBytes: number;
      try {
        // A launch that lost the precise-heap flag reports a quantized, cached figure, which a
        // ceiling would pass or fail on a bucket boundary rather than on the renderer's heap.
        await expectPreciseHeapInstrument(consoleApplication, heapProbe);

        atRestHeapBytes = await heapProbe.readSettledBytes();
      } finally {
        // Detached before the window closes: detaching a DevTools session from a closed
        // application raises over whatever the body was failing on.
        await heapProbe.detach();
      }
      const verdict = evaluateBudget(budget, atRestHeapBytes);

      // Printed before the assertion so a shrinking margin is visible before a run crosses.
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

      // A ceiling planted one byte under the reading must fail the comparison just passed.
      expect(
        evaluateBudget(budgetWithCeilingBelow(atRestHeapBytes), atRestHeapBytes).withinBudget,
      ).toBe(false);
    });
  });
});
