// The renderer heap-at-rest budget: the heap with one session open at rest stays under the
// ceiling in `tests/budget/document.json`, compared through the registry's own `evaluateBudget`.
//
// The reading is taken here, not in the budget CLI: the figure is a renderer heap, and a Node
// process holds no Chromium, React, DOM or app store. Only the built app holds the subject.
// It is not taken in `steady-state.test.ts` either: that file bounds how far the heap moves and
// owns no ceiling, this one bounds what the heap is at one quiet instant and owns no growth
// rule, so no number has two owners.
//
// "One session open at rest" is established by the run, not assumed:
//   - One session open: the app launches on the concurrent-streaming scenario and navigates
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

import { withLaunchedApp } from "../../helpers/electron/harness.js";
import { fixtureBundleExists } from "../../helpers/fixture/bundle.js";
import {
  deliverWholeScenario,
  ENDURANCE_LAUNCH_OPTIONS,
  expectConcurrentStreamingSessionCarriesContent,
  openConcurrentStreamingSessionRoute,
} from "../workload.js";
import { expectPreciseHeapInstrument, RendererHeapProbe } from "./instrument.js";
import { CONCURRENT_STREAMING_SCENARIO } from "#fixtures/scenarios/concurrent-streaming.js";
import { BudgetRegistry } from "../../helpers/budget/registry.js";
import { evaluateBudget } from "../../helpers/budget/evaluation.js";

const bundleIsBuilt = fixtureBundleExists();

/** The budget row this file measures. */
const HEAP_AT_REST_BUDGET_ID = "renderer-heap-at-rest";

const registry = BudgetRegistry.load();
const budget = registry.requireBudget(HEAP_AT_REST_BUDGET_ID);

describe.skipIf(!bundleIsBuilt)("endurance — the app at rest with one session open", () => {
  it("holds the renderer heap under the budget's ceiling", async () => {
    await withLaunchedApp(ENDURANCE_LAUNCH_OPTIONS, async (appUnderTest) => {
      await openConcurrentStreamingSessionRoute(appUnderTest);
      const deliveredBeatCount = await deliverWholeScenario(appUnderTest);
      expect(
        deliveredBeatCount,
        "the scenario handle is not exposed by this build, so " +
          "nothing drove content into the session being measured",
      ).not.toBeNull();
      expect(Number(deliveredBeatCount)).toBe(CONCURRENT_STREAMING_SCENARIO.beats.length);
      await expectConcurrentStreamingSessionCarriesContent(appUnderTest);

      // Attached before the precondition, which needs it: the precondition takes each of its
      // two readings behind this reader's forced collection, so the difference is the probe's
      // allocation and not whatever the collector reclaimed in between.
      const heapProbe = await RendererHeapProbe.attachTo(appUnderTest);
      let atRestHeapBytes: number;
      try {
        // A launch that lost the precise-heap flag reports a quantized, cached figure, which a
        // ceiling would pass or fail on a bucket boundary rather than on the renderer's heap.
        await expectPreciseHeapInstrument(appUnderTest, heapProbe);

        atRestHeapBytes = await heapProbe.readSettledBytes();
      } finally {
        // Detached before the window closes: detaching a DevTools session from a closed
        // application raises over whatever the body was failing on.
        await heapProbe.detach();
      }
      const verdict = evaluateBudget(budget, atRestHeapBytes);

      // Printed before the assertion so a shrinking margin is visible before a run crosses.
      process.stdout.write(
        `[endurance] heap at rest ${String(Math.round(atRestHeapBytes / 1024))} kB ` +
          `of ${String(Math.round(budget.limit.canonicalValue / 1024))} kB ` +
          `(${(verdict.utilizationFraction * 100).toFixed(1)} % of budget) with ` +
          `${String(deliveredBeatCount)} beats delivered into one open session\n`,
      );

      expect(
        verdict.withinBudget,
        `${budget.label}: ${String(atRestHeapBytes)} B against ` +
          `a ${String(budget.limit.canonicalValue)} B ceiling`,
      ).toBe(true);
    });
  });
});
