// The overlay scrollbar budgets: how many bars a window has started while the concurrent-streaming
// session streams with no pointer over it, and the most it holds while a person wheels that
// conversation from its first row to its last, each compared through the registry's own
// `evaluateBudget`. Counts against the fixture's frozen clock, so they gate on every machine;
// what a started bar costs a frame is printed by `frame-time.test.ts` beside its own figure.
//
// Each case's negative control starts one bar past its ceiling on planted scrollers in the same
// window and reads again, so a reading that counted nothing, or a selector that stopped matching
// the library's marker, fails instead of reporting a window under budget.

import process from "node:process";

import { describe, expect, it } from "vitest";

import { withLaunchedApp } from "../../helpers/electron/harness.js";
import { fixtureBundleExists } from "../../helpers/fixture/bundle.js";
import { expectFourLaneWorkloadInsideWindow, sampleFrameTimings } from "../frame-sampling.js";
import {
  deliverWholeScenario,
  ENDURANCE_LAUNCH_OPTIONS,
  expectConcurrentStreamingSessionCarriesContent,
  openConcurrentStreamingSessionRoute,
} from "../workload.js";
import {
  plantStartedOverlayScrollbars,
  readOverlayScrollbars,
  walkConversationByWheel,
} from "./instances.js";
import { BudgetRegistry } from "../../helpers/budget/registry.js";
import { evaluateBudget } from "../../helpers/budget/evaluation.js";

const registry = BudgetRegistry.load();
const streamingBudget = registry.requireBudget("overlay-scrollbars-started-streaming");
const wheelingBudget = registry.requireBudget("overlay-scrollbars-started-wheeling");

/** How many more bars take a window holding `startedCount` one past a row's ceiling. */
function pastCeiling(ceiling: number, startedCount: number): number {
  return Math.floor(ceiling) + 1 - startedCount;
}

describe.skipIf(!fixtureBundleExists())("endurance — overlay scrollbars started", () => {
  it("starts no bar nobody reached for while four lanes stream", async () => {
    await withLaunchedApp(ENDURANCE_LAUNCH_OPTIONS, async (appUnderTest) => {
      await openConcurrentStreamingSessionRoute(appUnderTest);
      // The sampler drives the script, so the census is read over a window the four lanes
      // streamed inside.
      expectFourLaneWorkloadInsideWindow(await sampleFrameTimings(appUnderTest, 0));
      const census = await readOverlayScrollbars(appUnderTest);
      const verdict = evaluateBudget(streamingBudget, census.startedHosts.length);
      process.stdout.write(
        `[endurance] overlay scrollbars started while streaming: ` +
          `${String(census.startedHosts.length)} of ${String(streamingBudget.limit.value)} ` +
          `(${census.startedHosts.join(", ")}); ${String(census.awaitingCount)} waiting\n`,
      );
      expect(
        verdict.withinBudget,
        `${streamingBudget.label}: ${census.startedHosts.join(", ")}`,
      ).toBe(true);

      await plantStartedOverlayScrollbars(
        appUnderTest,
        pastCeiling(streamingBudget.limit.canonicalValue, census.startedHosts.length),
      );
      const planted = await readOverlayScrollbars(appUnderTest);
      expect(
        evaluateBudget(streamingBudget, planted.startedHosts.length).withinBudget,
        "bars started past the ceiling read as within it, so the count would pass a window " +
          "that started a bar on every scroller",
      ).toBe(false);
    });
  });

  it("holds the started bars under the ceiling while the conversation is wheeled end to end", async () => {
    await withLaunchedApp(ENDURANCE_LAUNCH_OPTIONS, async (appUnderTest) => {
      await openConcurrentStreamingSessionRoute(appUnderTest);
      await deliverWholeScenario(appUnderTest);
      await expectConcurrentStreamingSessionCarriesContent(appUnderTest);
      const walk = await walkConversationByWheel(appUnderTest);
      const verdict = evaluateBudget(wheelingBudget, walk.peakStartedCount);
      process.stdout.write(
        `[endurance] overlay scrollbars started while wheeling ${String(walk.stepCount)} steps: ` +
          `peak ${String(walk.peakStartedCount)} of ${String(wheelingBudget.limit.value)} ` +
          `(${walk.startedHosts.join(", ")})\n`,
      );
      expect(walk.stepCount).toBeGreaterThan(1);
      expect(verdict.withinBudget, `${wheelingBudget.label}: ${walk.startedHosts.join(", ")}`).toBe(
        true,
      );

      const settled = await readOverlayScrollbars(appUnderTest);
      await plantStartedOverlayScrollbars(
        appUnderTest,
        pastCeiling(wheelingBudget.limit.canonicalValue, settled.startedHosts.length),
      );
      const planted = await readOverlayScrollbars(appUnderTest);
      expect(
        evaluateBudget(wheelingBudget, planted.startedHosts.length).withinBudget,
        "bars started past the ceiling read as within it, so the walk would pass a conversation " +
          "that started a bar on every row it mounted",
      ).toBe(false);
    });
  });
});
